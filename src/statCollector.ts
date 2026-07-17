import { ChildProcess, spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import axios from 'axios'
import { Chart, registerables } from 'chart.js'
import type { ChartConfiguration, ChartItem, ChartOptions } from 'chart.js'
import type {
  Canvas as SkiaCanvasCtor,
  Image as SkiaImageCtor
} from 'skia-canvas'
import { GLIBC, family as detectLibcFamily } from 'detect-libc'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  CPUStats,
  DiskSizeStats,
  DiskStats,
  GraphResponse,
  LineGraphOptions,
  MemoryStats,
  NetworkStats,
  ProcessedCPUStats,
  ProcessedDiskSizeStats,
  ProcessedDiskStats,
  ProcessedMemoryStats,
  ProcessedNetworkStats,
  ProcessedStats,
  StackedAreaGraphOptions,
  WorkflowJobType
} from './interfaces/index.js'
import artifact from '@actions/artifact'
import * as logger from './logger.js'

Chart.register(...registerables)

const STAT_SERVER_PORT = 7777

const BLACK = '#000000'
const WHITE = '#FFFFFF'

const CHART_WIDTH = 800
const CHART_HEIGHT = 400

interface SkiaCanvasExports {
  Canvas: typeof SkiaCanvasCtor
  Image: typeof SkiaImageCtor
}

// Keep in sync with the `skia-canvas` version pinned in package.json.
const SKIA_CANVAS_VERSION = '3.0.8'
const SKIA_CANVAS_RELEASE_URL = `https://github.com/samizdatco/skia-canvas/releases/download/v${SKIA_CANVAS_VERSION}`

// sha256 digests of that version's prebuilt binaries, copied from its
// package.json `prebuild` field, used to verify the download below.
const SKIA_CANVAS_PREBUILD_HASHES: { readonly [asset: string]: string } = {
  'darwin-arm64.gz':
    'sha256:df5f6aec9b92a83861473dff8cf1ed3aea16b89af6f66a9cfbc25ff7fc7460a9',
  'darwin-x64.gz':
    'sha256:3301d9241b661f30dcaf73c413b91549d020d7c2faff4b13905007b93ff66736',
  'linux-arm64-glibc.gz':
    'sha256:0665d07a60c05d912a2fd1459aeb37714eb0445c2f7848407638546c3d2e1a70',
  'linux-arm64-musl.gz':
    'sha256:27c58e0027c0507a7fcca274492c23b52d19b2a73ffe3199fd6fd808b578f78f',
  'linux-x64-glibc.gz':
    'sha256:f45925290599d4b7cb5211c123fadee27bc899d7556696e2e333d0efac6937b2',
  'linux-x64-musl.gz':
    'sha256:be1bdee982d2b4abf2827d97d04d212bb03ab849177f40a37023401c61d3e730',
  'win32-arm64.gz':
    'sha256:53de01055e63bb610aece10abf6520f7140a5f25c2a8a7f9361cd7529b71e333',
  'win32-x64.gz':
    'sha256:bdf56f8b0e0473ec414f510b5b7068d33a76b3488fd608f49ca92d5bfb77b428'
}

let skiaCanvasPromise: Promise<SkiaCanvasExports> | null = null

// `skia-canvas`'s JS (and its own JS dependencies) are bundled into the ncc
// output like any other dependency. Only its native addon is special-cased:
// `package.json`'s `ncc build` scripts pass `--external ../skia.node`, the
// exact relative specifier skia-canvas's own `classes/neon.js` requires it
// with, so ncc leaves just that one require as a plain runtime lookup
// relative to this bundle's own location instead of baking in whichever
// platform's `skia.node` happened to be present when this package was built
// (the bundle is built once but runs on whichever OS/arch the workflow uses).
// We fetch a prebuilt binary matching the actual runner into that exact spot
// before the first render, straight from skia-canvas's own GitHub release (no `npm
// install` and no external chart-rendering service involved).
async function ensureSkiaCanvasBinary(): Promise<void> {
  const binaryPath = path.join(import.meta.dirname, '..', 'skia.node')
  if (fs.existsSync(binaryPath)) {
    return
  }

  const asset = `${await skiaCanvasAssetTriplet()}.gz`
  const url = `${SKIA_CANVAS_RELEASE_URL}/${asset}`
  logger.debug(`Fetching skia-canvas native binary from ${url} ...`)

  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer'
  })
  const gzipped = Buffer.from(response.data)

  const expectedHash = SKIA_CANVAS_PREBUILD_HASHES[asset]
  const actualHash = `sha256:${crypto.createHash('sha256').update(gzipped).digest('hex')}`
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(
      `skia-canvas prebuilt binary '${asset}' failed integrity check (expected ${expectedHash}, got ${actualHash})`
    )
  }

  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })
  fs.writeFileSync(binaryPath, zlib.gunzipSync(gzipped))
  logger.debug(`Fetched skia-canvas native binary to ${binaryPath}`)
}

async function skiaCanvasAssetTriplet(): Promise<string> {
  const { platform, arch } = process
  if (platform !== 'linux') {
    return `${platform}-${arch}`
  }
  const libc = (await detectLibcFamily()) === GLIBC ? 'glibc' : 'musl'
  return `${platform}-${arch}-${libc}`
}

async function loadSkiaCanvas(): Promise<SkiaCanvasExports> {
  await ensureSkiaCanvasBinary()
  return await import('skia-canvas')
}

async function ensureSkiaCanvas(): Promise<SkiaCanvasExports> {
  if (!skiaCanvasPromise) {
    skiaCanvasPromise = loadSkiaCanvas()
  }
  return skiaCanvasPromise
}

function artifactPageUrl(artifactId: number): string {
  const { owner, repo } = github.context.repo
  return `https://github.com/${owner}/${repo}/actions/runs/${github.context.runId}/artifacts/${artifactId}`
}

// GitHub strips `data:` URIs from `<img>` tags in both PR comments and job
// summaries, so a locally-rendered chart can't be embedded inline. Instead we
// upload the PNG as a workflow artifact and link to its page.
async function renderAndUploadChart(
  config: ChartConfiguration<'line'>,
  artifactName: string
): Promise<string> {
  const skiaCanvas = await ensureSkiaCanvas()
  Object.assign(global, { Image: skiaCanvas.Image })

  const canvasEl = new skiaCanvas.Canvas(CHART_WIDTH, CHART_HEIGHT)
  const chart = new Chart(
    canvasEl.getContext('2d') as unknown as ChartItem,
    config
  )
  const png = canvasEl.toBufferSync('png')
  chart.destroy()

  const tempDir = fs.mkdtempSync(
    path.join(
      process.env.RUNNER_TEMP || os.tmpdir(),
      'workflow-telemetry-chart-'
    )
  )
  try {
    const filePath = path.join(tempDir, `${artifactName}.png`)
    fs.writeFileSync(filePath, png)

    const { id } = await artifact.uploadArtifact(
      artifactName,
      [filePath],
      tempDir,
      { compressionLevel: 0 }
    )
    if (!id) {
      throw new Error(`Failed to upload chart artifact '${artifactName}'`)
    }

    return artifactPageUrl(id)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function formatTime(epochMillis: number): string {
  const date = new Date(epochMillis)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function buildChartOptions(
  axisColor: string,
  yLabel: string,
  stacked: boolean
): ChartOptions<'line'> {
  return {
    responsive: false,
    animation: false,
    devicePixelRatio: 1,
    scales: {
      x: {
        title: { display: true, text: 'Time', color: axisColor },
        ticks: { color: axisColor, maxRotation: 0, autoSkip: true },
        grid: { color: `${axisColor}33` }
      },
      y: {
        stacked,
        beginAtZero: true,
        title: { display: true, text: yLabel, color: axisColor },
        ticks: { color: axisColor },
        grid: { color: `${axisColor}33` }
      }
    },
    plugins: {
      legend: { labels: { color: axisColor } }
    }
  }
}

async function triggerStatCollect(): Promise<void> {
  logger.debug('Triggering stat collect ...')
  const response = await axios.post(
    `http://localhost:${STAT_SERVER_PORT}/collect`
  )
  if (logger.isDebugEnabled()) {
    logger.debug(`Triggered stat collect: ${JSON.stringify(response.data)}`)
  }
}

async function reportWorkflowMetrics(
  currentJob: WorkflowJobType
): Promise<string> {
  const theme: string = core.getInput('theme', { required: false })
  let axisColor = BLACK
  switch (theme) {
    case 'light':
      axisColor = BLACK
      break
    case 'dark':
      axisColor = WHITE
      break
    default:
      core.warning(`Invalid theme: ${theme}`)
  }

  const artifactName = (chart: string): string =>
    `workflow-telemetry-${currentJob.id}-${chart}`

  const { userLoadX, systemLoadX } = await getCPUStats()
  const { activeMemoryX, availableMemoryX } = await getMemoryStats()
  const { networkReadX, networkWriteX } = await getNetworkStats()
  const { diskReadX, diskWriteX } = await getDiskStats()
  const { diskAvailableX, diskUsedX } = await getDiskSizeStats()

  const cpuLoad =
    userLoadX && userLoadX.length && systemLoadX && systemLoadX.length
      ? await getStackedAreaGraph(
          {
            label: 'CPU Load (%)',
            axisColor,
            areas: [
              {
                label: 'User Load',
                color: '#e41a1c99',
                points: userLoadX
              },
              {
                label: 'System Load',
                color: '#ff7f0099',
                points: systemLoadX
              }
            ]
          },
          artifactName('cpu-load')
        )
      : null

  const memoryUsage =
    activeMemoryX &&
    activeMemoryX.length &&
    availableMemoryX &&
    availableMemoryX.length
      ? await getStackedAreaGraph(
          {
            label: 'Memory Usage (MB)',
            axisColor,
            areas: [
              {
                label: 'Used',
                color: '#377eb899',
                points: activeMemoryX
              },
              {
                label: 'Free',
                color: '#4daf4a99',
                points: availableMemoryX
              }
            ]
          },
          artifactName('memory-usage')
        )
      : null

  const networkIORead =
    networkReadX && networkReadX.length
      ? await getLineGraph(
          {
            label: 'Network I/O Read (MB)',
            axisColor,
            line: {
              label: 'Read',
              color: '#be4d25',
              points: networkReadX
            }
          },
          artifactName('network-io-read')
        )
      : null

  const networkIOWrite =
    networkWriteX && networkWriteX.length
      ? await getLineGraph(
          {
            label: 'Network I/O Write (MB)',
            axisColor,
            line: {
              label: 'Write',
              color: '#6c25be',
              points: networkWriteX
            }
          },
          artifactName('network-io-write')
        )
      : null

  const diskIORead =
    diskReadX && diskReadX.length
      ? await getLineGraph(
          {
            label: 'Disk I/O Read (MB)',
            axisColor,
            line: {
              label: 'Read',
              color: '#be4d25',
              points: diskReadX
            }
          },
          artifactName('disk-io-read')
        )
      : null

  const diskIOWrite =
    diskWriteX && diskWriteX.length
      ? await getLineGraph(
          {
            label: 'Disk I/O Write (MB)',
            axisColor,
            line: {
              label: 'Write',
              color: '#6c25be',
              points: diskWriteX
            }
          },
          artifactName('disk-io-write')
        )
      : null

  const diskSizeUsage =
    diskUsedX && diskUsedX.length && diskAvailableX && diskAvailableX.length
      ? await getStackedAreaGraph(
          {
            label: 'Disk Usage (MB)',
            axisColor,
            areas: [
              {
                label: 'Used',
                color: '#377eb899',
                points: diskUsedX
              },
              {
                label: 'Free',
                color: '#4daf4a99',
                points: diskAvailableX
              }
            ]
          },
          artifactName('disk-size-usage')
        )
      : null

  const postContentItems: string[] = []
  if (cpuLoad) {
    postContentItems.push('### CPU Metrics', `[View chart](${cpuLoad.url})`, '')
  }
  if (memoryUsage) {
    postContentItems.push(
      '### Memory Metrics',
      `[View chart](${memoryUsage.url})`,
      ''
    )
  }
  if ((networkIORead && networkIOWrite) || (diskIORead && diskIOWrite)) {
    postContentItems.push(
      '### IO Metrics',
      '|               | Read      | Write     |',
      '|---            |---        |---        |'
    )
  }
  if (networkIORead && networkIOWrite) {
    postContentItems.push(
      `| Network I/O   | [View chart](${networkIORead.url})        | [View chart](${networkIOWrite.url})        |`
    )
  }
  if (diskIORead && diskIOWrite) {
    postContentItems.push(
      `| Disk I/O      | [View chart](${diskIORead.url})              | [View chart](${diskIOWrite.url})              |`
    )
  }
  if (diskSizeUsage) {
    postContentItems.push(
      '### Disk Size Metrics',
      `[View chart](${diskSizeUsage.url})`,
      ''
    )
  }

  return postContentItems.join('\n')
}

async function getCPUStats(): Promise<ProcessedCPUStats> {
  const userLoadX: ProcessedStats[] = []
  const systemLoadX: ProcessedStats[] = []

  logger.debug('Getting CPU stats ...')
  const response = await axios.get(`http://localhost:${STAT_SERVER_PORT}/cpu`)
  if (logger.isDebugEnabled()) {
    logger.debug(`Got CPU stats: ${JSON.stringify(response.data)}`)
  }

  response.data.forEach((element: CPUStats) => {
    userLoadX.push({
      x: element.time,
      y: element.userLoad && element.userLoad > 0 ? element.userLoad : 0
    })

    systemLoadX.push({
      x: element.time,
      y: element.systemLoad && element.systemLoad > 0 ? element.systemLoad : 0
    })
  })

  return { userLoadX, systemLoadX }
}

async function getMemoryStats(): Promise<ProcessedMemoryStats> {
  const activeMemoryX: ProcessedStats[] = []
  const availableMemoryX: ProcessedStats[] = []

  logger.debug('Getting memory stats ...')
  const response = await axios.get(
    `http://localhost:${STAT_SERVER_PORT}/memory`
  )
  if (logger.isDebugEnabled()) {
    logger.debug(`Got memory stats: ${JSON.stringify(response.data)}`)
  }

  response.data.forEach((element: MemoryStats) => {
    activeMemoryX.push({
      x: element.time,
      y:
        element.activeMemoryMb && element.activeMemoryMb > 0
          ? element.activeMemoryMb
          : 0
    })

    availableMemoryX.push({
      x: element.time,
      y:
        element.availableMemoryMb && element.availableMemoryMb > 0
          ? element.availableMemoryMb
          : 0
    })
  })

  return { activeMemoryX, availableMemoryX }
}

async function getNetworkStats(): Promise<ProcessedNetworkStats> {
  const networkReadX: ProcessedStats[] = []
  const networkWriteX: ProcessedStats[] = []

  logger.debug('Getting network stats ...')
  const response = await axios.get(
    `http://localhost:${STAT_SERVER_PORT}/network`
  )
  if (logger.isDebugEnabled()) {
    logger.debug(`Got network stats: ${JSON.stringify(response.data)}`)
  }

  response.data.forEach((element: NetworkStats) => {
    networkReadX.push({
      x: element.time,
      y: element.rxMb && element.rxMb > 0 ? element.rxMb : 0
    })

    networkWriteX.push({
      x: element.time,
      y: element.txMb && element.txMb > 0 ? element.txMb : 0
    })
  })

  return { networkReadX, networkWriteX }
}

async function getDiskStats(): Promise<ProcessedDiskStats> {
  const diskReadX: ProcessedStats[] = []
  const diskWriteX: ProcessedStats[] = []

  logger.debug('Getting disk stats ...')
  const response = await axios.get(`http://localhost:${STAT_SERVER_PORT}/disk`)
  if (logger.isDebugEnabled()) {
    logger.debug(`Got disk stats: ${JSON.stringify(response.data)}`)
  }

  response.data.forEach((element: DiskStats) => {
    diskReadX.push({
      x: element.time,
      y: element.rxMb && element.rxMb > 0 ? element.rxMb : 0
    })

    diskWriteX.push({
      x: element.time,
      y: element.wxMb && element.wxMb > 0 ? element.wxMb : 0
    })
  })

  return { diskReadX, diskWriteX }
}

async function getDiskSizeStats(): Promise<ProcessedDiskSizeStats> {
  const diskAvailableX: ProcessedStats[] = []
  const diskUsedX: ProcessedStats[] = []

  logger.debug('Getting disk size stats ...')
  const response = await axios.get(
    `http://localhost:${STAT_SERVER_PORT}/disk_size`
  )
  if (logger.isDebugEnabled()) {
    logger.debug(`Got disk size stats: ${JSON.stringify(response.data)}`)
  }

  response.data.forEach((element: DiskSizeStats) => {
    diskAvailableX.push({
      x: element.time,
      y:
        element.availableSizeMb && element.availableSizeMb > 0
          ? element.availableSizeMb
          : 0
    })

    diskUsedX.push({
      x: element.time,
      y: element.usedSizeMb && element.usedSizeMb > 0 ? element.usedSizeMb : 0
    })
  })

  return { diskAvailableX, diskUsedX }
}

async function getLineGraph(
  options: LineGraphOptions,
  artifactName: string
): Promise<GraphResponse | undefined> {
  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels: options.line.points.map(point => formatTime(point.x)),
      datasets: [
        {
          label: options.line.label,
          data: options.line.points.map(point => point.y),
          borderColor: options.line.color,
          backgroundColor: `${options.line.color}33`,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: buildChartOptions(options.axisColor, options.label, false)
  }

  try {
    const url = await renderAndUploadChart(config, artifactName)
    return { id: slugify(options.label), url }
  } catch (error: any) {
    logger.error(error)
    logger.error(`getLineGraph ${JSON.stringify(config)}`)
    return undefined
  }
}

async function getStackedAreaGraph(
  options: StackedAreaGraphOptions,
  artifactName: string
): Promise<GraphResponse | undefined> {
  const labels = options.areas.length
    ? options.areas[0].points.map(point => formatTime(point.x))
    : []

  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels,
      datasets: options.areas.map((area, index) => ({
        label: area.label,
        data: area.points.map(point => point.y),
        borderColor: area.color,
        backgroundColor: area.color,
        fill: index === 0 ? 'origin' : '-1',
        tension: 0.1,
        pointRadius: 0
      }))
    },
    options: buildChartOptions(options.axisColor, options.label, true)
  }

  try {
    const url = await renderAndUploadChart(config, artifactName)
    return { id: slugify(options.label), url }
  } catch (error: any) {
    logger.error(error)
    logger.error(`getStackedAreaGraph ${JSON.stringify(config)}`)
    return undefined
  }
}

///////////////////////////

export async function start(): Promise<boolean> {
  logger.info(`Starting stat collector ...`)

  try {
    let metricFrequency = 0
    const metricFrequencyInput: string = core.getInput('metric_frequency')
    if (metricFrequencyInput) {
      const metricFrequencyVal: number = parseInt(metricFrequencyInput)
      if (Number.isInteger(metricFrequencyVal)) {
        metricFrequency = metricFrequencyVal * 1000
      }
    }

    const child: ChildProcess = spawn(
      process.argv[0],
      [path.join(import.meta.dirname, '../scw/index.js')],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          WORKFLOW_TELEMETRY_STAT_FREQ: metricFrequency
            ? `${metricFrequency}`
            : undefined
        }
      }
    )
    child.unref()

    logger.info(`Started stat collector`)

    return true
  } catch (error: any) {
    logger.error('Unable to start stat collector')
    logger.error(error)

    return false
  }
}

export async function finish(currentJob: WorkflowJobType): Promise<boolean> {
  logger.info(`Finishing stat collector ...`)

  try {
    // Trigger stat collect, so we will have remaining stats since the latest schedule
    await triggerStatCollect()

    logger.info(`Finished stat collector`)

    return true
  } catch (error: any) {
    logger.error('Unable to finish stat collector')
    logger.error(error)

    return false
  }
}

export async function report(
  currentJob: WorkflowJobType
): Promise<string | null> {
  logger.info(`Reporting stat collector result ...`)

  try {
    const postContent: string = await reportWorkflowMetrics(currentJob)

    logger.info(`Reported stat collector result`)

    return postContent
  } catch (error: any) {
    logger.error('Unable to report stat collector result')
    logger.error(error)

    return null
  }
}
