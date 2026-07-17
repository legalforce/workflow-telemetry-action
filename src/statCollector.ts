import { ChildProcess, execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import axios from 'axios'
import { Chart, registerables } from 'chart.js'
import type { ChartConfiguration, ChartItem, ChartOptions } from 'chart.js'
import * as core from '@actions/core'
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
} from './interfaces'
import * as logger from './logger'

Chart.register(...registerables)

const STAT_SERVER_PORT = 7777

const BLACK = '#000000'
const WHITE = '#FFFFFF'

const CHART_WIDTH = 800
const CHART_HEIGHT = 400

// Pinned so every run installs the same, already-verified `canvas` build.
const CANVAS_PACKAGE_VERSION = '3.2.3'

interface CanvasLike {
  getContext(contextId: '2d'): unknown
  toBuffer(mimeType: string): Buffer
}

interface CanvasModule {
  createCanvas(width: number, height: number): CanvasLike
  Image: new () => unknown
}

let canvasModulePromise: Promise<CanvasModule> | null = null

// `canvas` ships a native addon, so it can't be embedded in the ncc bundle
// (the bundle is built once but runs on whichever OS/arch the workflow uses).
// Installing it on demand lets npm fetch the prebuilt binary that matches
// the actual runner, without depending on an external chart-rendering service.
async function ensureCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = installAndLoadCanvasModule()
  }
  return canvasModulePromise
}

async function installAndLoadCanvasModule(): Promise<CanvasModule> {
  const installDir = path.join(
    process.env.RUNNER_TEMP || os.tmpdir(),
    'workflow-telemetry-action-canvas'
  )
  fs.mkdirSync(installDir, { recursive: true })

  const canvasEntry = path.join(installDir, 'node_modules', 'canvas')
  if (!fs.existsSync(path.join(canvasEntry, 'package.json'))) {
    logger.debug(
      `Installing canvas@${CANVAS_PACKAGE_VERSION} into ${installDir} ...`
    )
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        `canvas@${CANVAS_PACKAGE_VERSION}`,
        '--no-save',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        '--loglevel=error'
      ],
      { cwd: installDir, stdio: 'pipe' }
    )
    logger.debug(`Installed canvas@${CANVAS_PACKAGE_VERSION}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-dynamic-require
  return require(canvasEntry)
}

async function renderChartToDataUri(
  config: ChartConfiguration<'line'>
): Promise<string> {
  const canvasModule = await ensureCanvasModule()
  Object.assign(global, { Image: canvasModule.Image })

  const canvasEl = canvasModule.createCanvas(CHART_WIDTH, CHART_HEIGHT)
  const chart = new Chart(canvasEl.getContext('2d') as ChartItem, config)
  const buffer = canvasEl.toBuffer('image/png')
  chart.destroy()

  return `data:image/png;base64,${buffer.toString('base64')}`
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

async function reportWorkflowMetrics(): Promise<string> {
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

  const { userLoadX, systemLoadX } = await getCPUStats()
  const { activeMemoryX, availableMemoryX } = await getMemoryStats()
  const { networkReadX, networkWriteX } = await getNetworkStats()
  const { diskReadX, diskWriteX } = await getDiskStats()
  const { diskAvailableX, diskUsedX } = await getDiskSizeStats()

  const cpuLoad =
    userLoadX && userLoadX.length && systemLoadX && systemLoadX.length
      ? await getStackedAreaGraph({
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
        })
      : null

  const memoryUsage =
    activeMemoryX &&
    activeMemoryX.length &&
    availableMemoryX &&
    availableMemoryX.length
      ? await getStackedAreaGraph({
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
        })
      : null

  const networkIORead =
    networkReadX && networkReadX.length
      ? await getLineGraph({
          label: 'Network I/O Read (MB)',
          axisColor,
          line: {
            label: 'Read',
            color: '#be4d25',
            points: networkReadX
          }
        })
      : null

  const networkIOWrite =
    networkWriteX && networkWriteX.length
      ? await getLineGraph({
          label: 'Network I/O Write (MB)',
          axisColor,
          line: {
            label: 'Write',
            color: '#6c25be',
            points: networkWriteX
          }
        })
      : null

  const diskIORead =
    diskReadX && diskReadX.length
      ? await getLineGraph({
          label: 'Disk I/O Read (MB)',
          axisColor,
          line: {
            label: 'Read',
            color: '#be4d25',
            points: diskReadX
          }
        })
      : null

  const diskIOWrite =
    diskWriteX && diskWriteX.length
      ? await getLineGraph({
          label: 'Disk I/O Write (MB)',
          axisColor,
          line: {
            label: 'Write',
            color: '#6c25be',
            points: diskWriteX
          }
        })
      : null

  const diskSizeUsage =
    diskUsedX && diskUsedX.length && diskAvailableX && diskAvailableX.length
      ? await getStackedAreaGraph({
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
        })
      : null

  const postContentItems: string[] = []
  if (cpuLoad) {
    postContentItems.push(
      '### CPU Metrics',
      `<img alt="${cpuLoad.id}" src="${cpuLoad.dataUri}" />`,
      ''
    )
  }
  if (memoryUsage) {
    postContentItems.push(
      '### Memory Metrics',
      `<img alt="${memoryUsage.id}" src="${memoryUsage.dataUri}" />`,
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
      `| Network I/O   | <img alt="${networkIORead.id}" src="${networkIORead.dataUri}" />        | <img alt="${networkIOWrite.id}" src="${networkIOWrite.dataUri}" />        |`
    )
  }
  if (diskIORead && diskIOWrite) {
    postContentItems.push(
      `| Disk I/O      | <img alt="${diskIORead.id}" src="${diskIORead.dataUri}" />              | <img alt="${diskIOWrite.id}" src="${diskIOWrite.dataUri}" />              |`
    )
  }
  if (diskSizeUsage) {
    postContentItems.push(
      '### Disk Size Metrics',
      `<img alt="${diskSizeUsage.id}" src="${diskSizeUsage.dataUri}" />`,
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
  options: LineGraphOptions
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
    const dataUri = await renderChartToDataUri(config)
    return { id: slugify(options.label), dataUri }
  } catch (error: any) {
    logger.error(error)
    logger.error(`getLineGraph ${JSON.stringify(config)}`)
    return undefined
  }
}

async function getStackedAreaGraph(
  options: StackedAreaGraphOptions
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
    const dataUri = await renderChartToDataUri(config)
    return { id: slugify(options.label), dataUri }
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
      [path.join(__dirname, '../scw/index.js')],
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
    const postContent: string = await reportWorkflowMetrics()

    logger.info(`Reported stat collector result`)

    return postContent
  } catch (error: any) {
    logger.error('Unable to report stat collector result')
    logger.error(error)

    return null
  }
}
