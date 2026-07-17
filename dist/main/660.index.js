export const id = 660;
export const ids = [660];
export const modules = {

/***/ 31133:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

var debug;

module.exports = function () {
  if (!debug) {
    try {
      /* eslint global-require: off */
      debug = __webpack_require__(38237)("follow-redirects");
    }
    catch (error) { /* */ }
    if (typeof debug !== "function") {
      debug = function () { /* */ };
    }
  }
  debug.apply(null, arguments);
};


/***/ }),

/***/ 67707:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

var url = __webpack_require__(57310);
var URL = url.URL;
var http = __webpack_require__(13685);
var https = __webpack_require__(95687);
var Writable = (__webpack_require__(12781).Writable);
var assert = __webpack_require__(39491);
var debug = __webpack_require__(31133);

// Preventive platform detection
// istanbul ignore next
(function detectUnsupportedEnvironment() {
  var looksLikeNode = typeof process !== "undefined";
  var looksLikeBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  var looksLikeV8 = isFunction(Error.captureStackTrace);
  if (!looksLikeNode && (looksLikeBrowser || !looksLikeV8)) {
    console.warn("The follow-redirects package should be excluded from browser builds.");
  }
}());

// Whether to use the native URL object or the legacy url module
var useNativeURL = false;
try {
  assert(new URL(""));
}
catch (error) {
  useNativeURL = error.code === "ERR_INVALID_URL";
}

// HTTP headers to drop across HTTP/HTTPS and domain boundaries
var sensitiveHeaders = [
  "Authorization",
  "Proxy-Authorization",
  "Cookie",
];

// URL fields to preserve in copy operations
var preservedUrlFields = [
  "auth",
  "host",
  "hostname",
  "href",
  "path",
  "pathname",
  "port",
  "protocol",
  "query",
  "search",
  "hash",
];

// Create handlers that pass events from native requests
var events = ["abort", "aborted", "connect", "error", "socket", "timeout"];
var eventHandlers = Object.create(null);
events.forEach(function (event) {
  eventHandlers[event] = function (arg1, arg2, arg3) {
    this._redirectable.emit(event, arg1, arg2, arg3);
  };
});

// Error types with codes
var InvalidUrlError = createErrorType(
  "ERR_INVALID_URL",
  "Invalid URL",
  TypeError
);
var RedirectionError = createErrorType(
  "ERR_FR_REDIRECTION_FAILURE",
  "Redirected request failed"
);
var TooManyRedirectsError = createErrorType(
  "ERR_FR_TOO_MANY_REDIRECTS",
  "Maximum number of redirects exceeded",
  RedirectionError
);
var MaxBodyLengthExceededError = createErrorType(
  "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
  "Request body larger than maxBodyLength limit"
);
var WriteAfterEndError = createErrorType(
  "ERR_STREAM_WRITE_AFTER_END",
  "write after end"
);

// istanbul ignore next
var destroy = Writable.prototype.destroy || noop;

// An HTTP(S) request that can be redirected
function RedirectableRequest(options, responseCallback) {
  // Initialize the request
  Writable.call(this);
  this._sanitizeOptions(options);
  this._options = options;
  this._ended = false;
  this._ending = false;
  this._redirectCount = 0;
  this._redirects = [];
  this._requestBodyLength = 0;
  this._requestBodyBuffers = [];

  // Attach a callback if passed
  if (responseCallback) {
    this.on("response", responseCallback);
  }

  // React to responses of native requests
  var self = this;
  this._onNativeResponse = function (response) {
    try {
      self._processResponse(response);
    }
    catch (cause) {
      self.emit("error", cause instanceof RedirectionError ?
        cause : new RedirectionError({ cause: cause }));
    }
  };

  // Create filter for sensitive HTTP headers
  this._headerFilter = new RegExp("^(?:" +
      sensitiveHeaders.concat(options.sensitiveHeaders).map(escapeRegex).join("|") +
    ")$", "i");

  // Perform the first request
  this._performRequest();
}
RedirectableRequest.prototype = Object.create(Writable.prototype);

RedirectableRequest.prototype.abort = function () {
  destroyRequest(this._currentRequest);
  this._currentRequest.abort();
  this.emit("abort");
};

RedirectableRequest.prototype.destroy = function (error) {
  destroyRequest(this._currentRequest, error);
  destroy.call(this, error);
  return this;
};

// Writes buffered data to the current native request
RedirectableRequest.prototype.write = function (data, encoding, callback) {
  // Writing is not allowed if end has been called
  if (this._ending) {
    throw new WriteAfterEndError();
  }

  // Validate input and shift parameters if necessary
  if (!isString(data) && !isBuffer(data)) {
    throw new TypeError("data should be a string, Buffer or Uint8Array");
  }
  if (isFunction(encoding)) {
    callback = encoding;
    encoding = null;
  }

  // Ignore empty buffers, since writing them doesn't invoke the callback
  // https://github.com/nodejs/node/issues/22066
  if (data.length === 0) {
    if (callback) {
      callback();
    }
    return;
  }
  // Only write when we don't exceed the maximum body length
  if (this._requestBodyLength + data.length <= this._options.maxBodyLength) {
    this._requestBodyLength += data.length;
    this._requestBodyBuffers.push({ data: data, encoding: encoding });
    this._currentRequest.write(data, encoding, callback);
  }
  // Error when we exceed the maximum body length
  else {
    this.emit("error", new MaxBodyLengthExceededError());
    this.abort();
  }
};

// Ends the current native request
RedirectableRequest.prototype.end = function (data, encoding, callback) {
  // Shift parameters if necessary
  if (isFunction(data)) {
    callback = data;
    data = encoding = null;
  }
  else if (isFunction(encoding)) {
    callback = encoding;
    encoding = null;
  }

  // Write data if needed and end
  if (!data) {
    this._ended = this._ending = true;
    this._currentRequest.end(null, null, callback);
  }
  else {
    var self = this;
    var currentRequest = this._currentRequest;
    this.write(data, encoding, function () {
      self._ended = true;
      currentRequest.end(null, null, callback);
    });
    this._ending = true;
  }
};

// Sets a header value on the current native request
RedirectableRequest.prototype.setHeader = function (name, value) {
  this._options.headers[name] = value;
  this._currentRequest.setHeader(name, value);
};

// Clears a header value on the current native request
RedirectableRequest.prototype.removeHeader = function (name) {
  delete this._options.headers[name];
  this._currentRequest.removeHeader(name);
};

// Global timeout for all underlying requests
RedirectableRequest.prototype.setTimeout = function (msecs, callback) {
  var self = this;

  // Destroys the socket on timeout
  function destroyOnTimeout(socket) {
    socket.setTimeout(msecs);
    socket.removeListener("timeout", socket.destroy);
    socket.addListener("timeout", socket.destroy);
  }

  // Sets up a timer to trigger a timeout event
  function startTimer(socket) {
    if (self._timeout) {
      clearTimeout(self._timeout);
    }
    self._timeout = setTimeout(function () {
      self.emit("timeout");
      clearTimer();
    }, msecs);
    destroyOnTimeout(socket);
  }

  // Stops a timeout from triggering
  function clearTimer() {
    // Clear the timeout
    if (self._timeout) {
      clearTimeout(self._timeout);
      self._timeout = null;
    }

    // Clean up all attached listeners
    self.removeListener("abort", clearTimer);
    self.removeListener("error", clearTimer);
    self.removeListener("response", clearTimer);
    self.removeListener("close", clearTimer);
    if (callback) {
      self.removeListener("timeout", callback);
    }
    if (!self.socket) {
      self._currentRequest.removeListener("socket", startTimer);
    }
  }

  // Attach callback if passed
  if (callback) {
    this.on("timeout", callback);
  }

  // Start the timer if or when the socket is opened
  if (this.socket) {
    startTimer(this.socket);
  }
  else {
    this._currentRequest.once("socket", startTimer);
  }

  // Clean up on events
  this.on("socket", destroyOnTimeout);
  this.on("abort", clearTimer);
  this.on("error", clearTimer);
  this.on("response", clearTimer);
  this.on("close", clearTimer);

  return this;
};

// Proxy all other public ClientRequest methods
[
  "flushHeaders", "getHeader",
  "setNoDelay", "setSocketKeepAlive",
].forEach(function (method) {
  RedirectableRequest.prototype[method] = function (a, b) {
    return this._currentRequest[method](a, b);
  };
});

// Proxy all public ClientRequest properties
["aborted", "connection", "socket"].forEach(function (property) {
  Object.defineProperty(RedirectableRequest.prototype, property, {
    get: function () { return this._currentRequest[property]; },
  });
});

RedirectableRequest.prototype._sanitizeOptions = function (options) {
  // Ensure headers are always present
  if (!options.headers) {
    options.headers = {};
  }
  if (!isArray(options.sensitiveHeaders)) {
    options.sensitiveHeaders = [];
  }

  // Since http.request treats host as an alias of hostname,
  // but the url module interprets host as hostname plus port,
  // eliminate the host property to avoid confusion.
  if (options.host) {
    // Use hostname if set, because it has precedence
    if (!options.hostname) {
      options.hostname = options.host;
    }
    delete options.host;
  }

  // Complete the URL object when necessary
  if (!options.pathname && options.path) {
    var searchPos = options.path.indexOf("?");
    if (searchPos < 0) {
      options.pathname = options.path;
    }
    else {
      options.pathname = options.path.substring(0, searchPos);
      options.search = options.path.substring(searchPos);
    }
  }
};


// Executes the next native request (initial or redirect)
RedirectableRequest.prototype._performRequest = function () {
  // Load the native protocol
  var protocol = this._options.protocol;
  var nativeProtocol = this._options.nativeProtocols[protocol];
  if (!nativeProtocol) {
    throw new TypeError("Unsupported protocol " + protocol);
  }

  // If specified, use the agent corresponding to the protocol
  // (HTTP and HTTPS use different types of agents)
  if (this._options.agents) {
    var scheme = protocol.slice(0, -1);
    this._options.agent = this._options.agents[scheme];
  }

  // Create the native request and set up its event handlers
  var request = this._currentRequest =
        nativeProtocol.request(this._options, this._onNativeResponse);
  request._redirectable = this;
  for (var event of events) {
    request.on(event, eventHandlers[event]);
  }

  // RFC7230§5.3.1: When making a request directly to an origin server, […]
  // a client MUST send only the absolute path […] as the request-target.
  this._currentUrl = /^\//.test(this._options.path) ?
    url.format(this._options) :
    // When making a request to a proxy, […]
    // a client MUST send the target URI in absolute-form […].
    this._options.path;

  // End a redirected request
  // (The first request must be ended explicitly with RedirectableRequest#end)
  if (this._isRedirect) {
    // Write the request entity and end
    var i = 0;
    var self = this;
    var buffers = this._requestBodyBuffers;
    (function writeNext(error) {
      // Only write if this request has not been redirected yet
      // istanbul ignore else
      if (request === self._currentRequest) {
        // Report any write errors
        // istanbul ignore if
        if (error) {
          self.emit("error", error);
        }
        // Write the next buffer if there are still left
        else if (i < buffers.length) {
          var buffer = buffers[i++];
          // istanbul ignore else
          if (!request.finished) {
            request.write(buffer.data, buffer.encoding, writeNext);
          }
        }
        // End the request if `end` has been called on us
        else if (self._ended) {
          request.end();
        }
      }
    }());
  }
};

// Processes a response from the current native request
RedirectableRequest.prototype._processResponse = function (response) {
  // Store the redirected response
  var statusCode = response.statusCode;
  if (this._options.trackRedirects) {
    this._redirects.push({
      url: this._currentUrl,
      headers: response.headers,
      statusCode: statusCode,
    });
  }

  // RFC7231§6.4: The 3xx (Redirection) class of status code indicates
  // that further action needs to be taken by the user agent in order to
  // fulfill the request. If a Location header field is provided,
  // the user agent MAY automatically redirect its request to the URI
  // referenced by the Location field value,
  // even if the specific status code is not understood.

  // If the response is not a redirect; return it as-is
  var location = response.headers.location;
  if (!location || this._options.followRedirects === false ||
      statusCode < 300 || statusCode >= 400) {
    response.responseUrl = this._currentUrl;
    response.redirects = this._redirects;
    this.emit("response", response);

    // Clean up
    this._requestBodyBuffers = [];
    return;
  }

  // The response is a redirect, so abort the current request
  destroyRequest(this._currentRequest);
  // Discard the remainder of the response to avoid waiting for data
  response.destroy();

  // RFC7231§6.4: A client SHOULD detect and intervene
  // in cyclical redirections (i.e., "infinite" redirection loops).
  if (++this._redirectCount > this._options.maxRedirects) {
    throw new TooManyRedirectsError();
  }

  // Store the request headers if applicable
  var requestHeaders;
  var beforeRedirect = this._options.beforeRedirect;
  if (beforeRedirect) {
    requestHeaders = Object.assign({
      // The Host header was set by nativeProtocol.request
      Host: response.req.getHeader("host"),
    }, this._options.headers);
  }

  // RFC7231§6.4: Automatic redirection needs to done with
  // care for methods not known to be safe, […]
  // RFC7231§6.4.2–3: For historical reasons, a user agent MAY change
  // the request method from POST to GET for the subsequent request.
  var method = this._options.method;
  if ((statusCode === 301 || statusCode === 302) && this._options.method === "POST" ||
      // RFC7231§6.4.4: The 303 (See Other) status code indicates that
      // the server is redirecting the user agent to a different resource […]
      // A user agent can perform a retrieval request targeting that URI
      // (a GET or HEAD request if using HTTP) […]
      (statusCode === 303) && !/^(?:GET|HEAD)$/.test(this._options.method)) {
    this._options.method = "GET";
    // Drop a possible entity and headers related to it
    this._requestBodyBuffers = [];
    removeMatchingHeaders(/^content-/i, this._options.headers);
  }

  // Drop the Host header, as the redirect might lead to a different host
  var currentHostHeader = removeMatchingHeaders(/^host$/i, this._options.headers);

  // If the redirect is relative, carry over the host of the last request
  var currentUrlParts = parseUrl(this._currentUrl);
  var currentHost = currentHostHeader || currentUrlParts.host;
  var currentUrl = /^\w+:/.test(location) ? this._currentUrl :
    url.format(Object.assign(currentUrlParts, { host: currentHost }));

  // Create the redirected request
  var redirectUrl = resolveUrl(location, currentUrl);
  debug("redirecting to", redirectUrl.href);
  this._isRedirect = true;
  spreadUrlObject(redirectUrl, this._options);

  // Drop confidential headers when redirecting to a less secure protocol
  // or to a different domain that is not a superdomain
  if (redirectUrl.protocol !== currentUrlParts.protocol &&
     redirectUrl.protocol !== "https:" ||
     redirectUrl.host !== currentHost &&
     !isSubdomain(redirectUrl.host, currentHost)) {
    removeMatchingHeaders(this._headerFilter, this._options.headers);
  }

  // Evaluate the beforeRedirect callback
  if (isFunction(beforeRedirect)) {
    var responseDetails = {
      headers: response.headers,
      statusCode: statusCode,
    };
    var requestDetails = {
      url: currentUrl,
      method: method,
      headers: requestHeaders,
    };
    beforeRedirect(this._options, responseDetails, requestDetails);
    this._sanitizeOptions(this._options);
  }

  // Perform the redirected request
  this._performRequest();
};

// Wraps the key/value object of protocols with redirect functionality
function wrap(protocols) {
  // Default settings
  var exports = {
    maxRedirects: 21,
    maxBodyLength: 10 * 1024 * 1024,
  };

  // Wrap each protocol
  var nativeProtocols = {};
  Object.keys(protocols).forEach(function (scheme) {
    var protocol = scheme + ":";
    var nativeProtocol = nativeProtocols[protocol] = protocols[scheme];
    var wrappedProtocol = exports[scheme] = Object.create(nativeProtocol);

    // Executes a request, following redirects
    function request(input, options, callback) {
      // Parse parameters, ensuring that input is an object
      if (isURL(input)) {
        input = spreadUrlObject(input);
      }
      else if (isString(input)) {
        input = spreadUrlObject(parseUrl(input));
      }
      else {
        callback = options;
        options = validateUrl(input);
        input = { protocol: protocol };
      }
      if (isFunction(options)) {
        callback = options;
        options = null;
      }

      // Set defaults
      options = Object.assign({
        maxRedirects: exports.maxRedirects,
        maxBodyLength: exports.maxBodyLength,
      }, input, options);
      options.nativeProtocols = nativeProtocols;
      if (!isString(options.host) && !isString(options.hostname)) {
        options.hostname = "::1";
      }

      assert.equal(options.protocol, protocol, "protocol mismatch");
      debug("options", options);
      return new RedirectableRequest(options, callback);
    }

    // Executes a GET request, following redirects
    function get(input, options, callback) {
      var wrappedRequest = wrappedProtocol.request(input, options, callback);
      wrappedRequest.end();
      return wrappedRequest;
    }

    // Expose the properties on the wrapped protocol
    Object.defineProperties(wrappedProtocol, {
      request: { value: request, configurable: true, enumerable: true, writable: true },
      get: { value: get, configurable: true, enumerable: true, writable: true },
    });
  });
  return exports;
}

function noop() { /* empty */ }

function parseUrl(input) {
  var parsed;
  // istanbul ignore else
  if (useNativeURL) {
    parsed = new URL(input);
  }
  else {
    // Ensure the URL is valid and absolute
    parsed = validateUrl(url.parse(input));
    if (!isString(parsed.protocol)) {
      throw new InvalidUrlError({ input });
    }
  }
  return parsed;
}

function resolveUrl(relative, base) {
  // istanbul ignore next
  return useNativeURL ? new URL(relative, base) : parseUrl(url.resolve(base, relative));
}

function validateUrl(input) {
  if (/^\[/.test(input.hostname) && !/^\[[:0-9a-f]+\]$/i.test(input.hostname)) {
    throw new InvalidUrlError({ input: input.href || input });
  }
  if (/^\[/.test(input.host) && !/^\[[:0-9a-f]+\](:\d+)?$/i.test(input.host)) {
    throw new InvalidUrlError({ input: input.href || input });
  }
  return input;
}

function spreadUrlObject(urlObject, target) {
  var spread = target || {};
  for (var key of preservedUrlFields) {
    spread[key] = urlObject[key];
  }

  // Fix IPv6 hostname
  if (spread.hostname.startsWith("[")) {
    spread.hostname = spread.hostname.slice(1, -1);
  }
  // Ensure port is a number
  if (spread.port !== "") {
    spread.port = Number(spread.port);
  }
  // Concatenate path
  spread.path = spread.search ? spread.pathname + spread.search : spread.pathname;

  return spread;
}

function removeMatchingHeaders(regex, headers) {
  var lastValue;
  for (var header in headers) {
    if (regex.test(header)) {
      lastValue = headers[header];
      delete headers[header];
    }
  }
  return (lastValue === null || typeof lastValue === "undefined") ?
    undefined : String(lastValue).trim();
}

function createErrorType(code, message, baseClass) {
  // Create constructor
  function CustomError(properties) {
    // istanbul ignore else
    if (isFunction(Error.captureStackTrace)) {
      Error.captureStackTrace(this, this.constructor);
    }
    Object.assign(this, properties || {});
    this.code = code;
    this.message = this.cause ? message + ": " + this.cause.message : message;
  }

  // Attach constructor and set default properties
  CustomError.prototype = new (baseClass || Error)();
  Object.defineProperties(CustomError.prototype, {
    constructor: {
      value: CustomError,
      enumerable: false,
    },
    name: {
      value: "Error [" + code + "]",
      enumerable: false,
    },
  });
  return CustomError;
}

function destroyRequest(request, error) {
  for (var event of events) {
    request.removeListener(event, eventHandlers[event]);
  }
  request.on("error", noop);
  request.destroy(error);
}

function isSubdomain(subdomain, domain) {
  assert(isString(subdomain) && isString(domain));
  var dot = subdomain.length - domain.length - 1;
  return dot > 0 && subdomain[dot] === "." && subdomain.endsWith(domain);
}

function isArray(value) {
  return value instanceof Array;
}

function isString(value) {
  return typeof value === "string" || value instanceof String;
}

function isFunction(value) {
  return typeof value === "function";
}

function isBuffer(value) {
  return typeof value === "object" && ("length" in value);
}

function isURL(value) {
  return URL && value instanceof URL;
}

function escapeRegex(regex) {
  return regex.replace(/[\]\\/()*+?.$]/g, "\\$&");
}

// Exports
module.exports = wrap({ http: http, https: https });
module.exports.wrap = wrap;


/***/ }),

/***/ 39991:
/***/ ((module) => {



/**
 * @module parenthesis
 */

function parse (str, opts) {
	// pretend non-string parsed per-se
	if (typeof str !== 'string') return [str]

	var res = [str]

	if (typeof opts === 'string' || Array.isArray(opts)) {
		opts = {brackets: opts}
	}
	else if (!opts) opts = {}

	var brackets = opts.brackets ? (Array.isArray(opts.brackets) ? opts.brackets : [opts.brackets]) : ['{}', '[]', '()']

	var escape = opts.escape || '___'

	var flat = !!opts.flat

	brackets.forEach(function (bracket) {
		// create parenthesis regex
		var pRE = new RegExp(['\\', bracket[0], '[^\\', bracket[0], '\\', bracket[1], ']*\\', bracket[1]].join(''))

		var ids = []

		function replaceToken(token, idx, str){
			// save token to res
			var refId = res.push(token.slice(bracket[0].length, -bracket[1].length)) - 1

			ids.push(refId)

			return escape + refId + escape
		}

		res.forEach(function (str, i) {
			var prevStr

			// replace paren tokens till there’s none
			var a = 0
			while (str != prevStr) {
				prevStr = str
				str = str.replace(pRE, replaceToken)
				if (a++ > 10e3) throw Error('References have circular dependency. Please, check them.')
			}

			res[i] = str
		})

		// wrap found refs to brackets
		ids = ids.reverse()
		res = res.map(function (str) {
			ids.forEach(function (id) {
				str = str.replace(new RegExp('(\\' + escape + id + '\\' + escape + ')', 'g'), bracket[0] + '$1' + bracket[1])
			})
			return str
		})
	})

	var re = new RegExp('\\' + escape + '([0-9]+)' + '\\' + escape)

	// transform references to tree
	function nest (str, refs, escape) {
		var res = [], match

		var a = 0
		while (match = re.exec(str)) {
			if (a++ > 10e3) throw Error('Circular references in parenthesis')

			res.push(str.slice(0, match.index))

			res.push(nest(refs[match[1]], refs))

			str = str.slice(match.index + match[0].length)
		}

		res.push(str)

		return res
	}

	return flat ? res : nest(res[0], res)
}

function stringify (arg, opts) {
	if (opts && opts.flat) {
		var escape = opts && opts.escape || '___'

		var str = arg[0], prevStr

		// pretend bad string stringified with no parentheses
		if (!str) return ''


		var re = new RegExp('\\' + escape + '([0-9]+)' + '\\' + escape)

		var a = 0
		while (str != prevStr) {
			if (a++ > 10e3) throw Error('Circular references in ' + arg)
			prevStr = str
			str = str.replace(re, replaceRef)
		}

		return str
	}

	return arg.reduce(function f (prev, curr) {
		if (Array.isArray(curr)) {
			curr = curr.reduce(f, '')
		}
		return prev + curr
	}, '')

	function replaceRef(match, idx){
		if (arg[idx] == null) throw Error('Reference ' + idx + 'is undefined')
		return arg[idx]
	}
}

function parenthesis (arg, opts) {
	if (Array.isArray(arg)) {
		return stringify(arg, opts)
	}
	else {
		return parse(arg, opts)
	}
}

parenthesis.parse = parse
parenthesis.stringify = stringify

module.exports = parenthesis


/***/ }),

/***/ 46155:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Canvas object & export options
//



const {fileURLToPath} = __webpack_require__(57310),
      {RustClass, core, inspect, argc, REPR} = __webpack_require__(7302),
      {Image, ImageData, pixelSize, getSharp} = __webpack_require__(39266),
      {Path2D} = __webpack_require__(24767),
      {toSkMatrix} = __webpack_require__(86515)

class Canvas extends RustClass{
  #contexts

  constructor(width, height, {textContrast=0, textGamma=1.4, gpu=true}={}){
    super(Canvas).alloc({textContrast, textGamma, gpu:!!gpu})
    this.#contexts = []
    Object.assign(this, {width, height})
  }

  getContext(kind){
    return (kind=="2d") ? this.#contexts[0] || this.newPage() : null
  }

  get gpu(){ return this.prop('engine')=='gpu' }
  set gpu(mode){ this.prop('engine', !!mode ? 'gpu' : 'cpu') }

  get engine(){ return JSON.parse(this.prop('engine_status')) }

  get width(){ return this.prop('width') }
  set width(w){
    this.prop('width', !Number.isNaN(+w) && +w>=0 ? w : 300)
    if (this.#contexts[0]) this.getContext("2d").ƒ('resetSize', core(this))
  }

  get height(){ return this.prop('height') }
  set height(h){
    this.prop('height', !Number.isNaN(+h) && +h>=0 ? h : 150)
    if (this.#contexts[0]) this.getContext("2d").ƒ('resetSize', core(this))
  }

  newPage(width, height){
    const {CanvasRenderingContext2D} = __webpack_require__(7949)
    let ctx = new CanvasRenderingContext2D(this)
    this.#contexts.unshift(ctx)
    if (arguments.length==2){
      Object.assign(this, {width, height})
    }
    return ctx
  }

  get pages(){
    return this.#contexts.slice().reverse()
  }

  get raw(){ return this.toBuffer("raw") }
  get png(){ return this.toBuffer("png") }
  get jpg(){ return this.toBuffer("jpg") }
  get pdf(){ return this.toBuffer("pdf") }
  get svg(){ return this.toBuffer("svg") }
  get webp(){ return this.toBuffer("webp") }

  // Warn about renamed methods but map them to the new names (for now)
  saveAs(){ _deprecated('Canvas.saveAs()'); this.toFile(...arguments) }
  saveAsSync(){ _deprecated('Canvas.saveAsSync()'); this.toFileSync(...arguments) }
  toDataURLSync(){ _deprecated('Canvas.toDataURLSync()'); this.toURLSync(...arguments) }

  toFile(filename, opts={}){
    let {pages, padding, pattern, ...rest} = exportOptions(this, {filename}, opts),
        args = [pages.map(core), pattern, padding, rest]
    return this.ƒ("save", ...args)
  }

  toFileSync(filename, opts={}){
    let {pages, padding, pattern, ...rest} = exportOptions(this, {filename}, opts)
    this.ƒ("saveSync", pages.map(core), pattern, padding, rest)
  }

  toBuffer(extension="png", opts={}){
    let {pages, ...rest} = exportOptions(this, {extension}, opts)
    return this.ƒ("toBuffer", pages.map(core), rest)
  }

  toBufferSync(extension="png", opts={}){
    let {pages, ...rest} = exportOptions(this, {extension}, opts)
    return this.ƒ("toBufferSync", pages.map(core), rest)
  }

  toURL(extension="png", opts={}){
    let {mime} = exportOptions(this, {extension}, opts),
        buffer = this.toBuffer(extension, opts);
    return buffer.then(data => `data:${mime};base64,${data.toString('base64')}`)
  }

  toURLSync(extension="png", opts={}){
    let {mime} = exportOptions(this, {extension}, opts),
        buffer = this.toBufferSync(extension, opts);
    return `data:${mime};base64,${buffer.toString('base64')}`
  }

  // Match the browser API in only accepting a single optional quality argument
  toDataURL(extension="png", quality){
    if (quality!==undefined && typeof quality!=='number'){
      throw TypeError("Expected a number in the range 0–1 for `quality` (use toURL() for additional rendering options)")
    }
    return this.toURLSync(extension, {quality})
  }

  toSharp({page, matte, msaa, density=1}={}){
    const {Readable} = __webpack_require__(84492),
          sharp = getSharp(),
          buffer = this.toBuffer("raw", {page, matte, density, msaa})

    return Readable.from(
      (async function * (){ yield buffer })()
    ).pipe(sharp({
      raw: {width:this.width*density, height:this.height*density, channels:4}
    }).withMetadata({density:density * 72}))
  }

  [REPR](depth, options) {
    let {width, height, gpu, engine, pages} = this
    return `Canvas ${inspect({width, height, gpu, engine, pages}, options)}`
  }
}

class CanvasGradient extends RustClass{
  constructor(style, ...coords){
    super(CanvasGradient)
    style = (style || "").toLowerCase()
    if (['linear', 'radial', 'conic'].includes(style)) this.init(style, ...coords)
    else throw new Error(`Function is not a constructor (use CanvasRenderingContext2D's "createConicGradient", "createLinearGradient", and "createRadialGradient" methods instead)`)
  }

  addColorStop(offset, color){
    this.ƒ('addColorStop', ...arguments)
  }

  [REPR](depth, options) {
    return `CanvasGradient (${this.ƒ("repr")})`
  }
}

class CanvasPattern extends RustClass{
  constructor(canvas, src, repeat){
    repeat = [...arguments].slice(2)
    super(CanvasPattern)
    if (src instanceof Image){
      let {width, height} = canvas
      this.init('from_image', core(src), width, height, ...repeat)
    }else if (src instanceof ImageData){
      this.init('from_image_data', src, ...repeat)
    }else if (src instanceof Canvas){
      let ctx = src.getContext('2d')
      this.init('from_canvas', core(ctx), ...repeat)
    }else{
      throw new Error("CanvasPatterns require a source Image or a Canvas")
    }
  }

  setTransform(matrix) { this.ƒ('setTransform', toSkMatrix.apply(null, arguments)) }

  [REPR](depth, options) {
    return `CanvasPattern (${this.ƒ("repr")})`
  }
}

class CanvasTexture extends RustClass{
  constructor(spacing, {path, color, angle, line, cap="butt", outline=false, offset=0}={}){
    super(CanvasTexture)
    argc(arguments, 1)
    let [x, y] = Array.isArray(offset) ? offset.concat(offset).slice(0, 2) : [offset, offset]
    let [h, v] = Array.isArray(spacing) ? spacing.concat(spacing).slice(0, 2) : [spacing, spacing]
    if (path!==undefined && !(path instanceof Path2D)){
      throw TypeError("Expected a Path2D object for `path`")
    }
    path = core(path)
    line = line != null ? line : (path ? 0 : 1)
    angle = angle != null ? angle : (path ? 0 : -Math.PI / 4)
    this.alloc(path, color, line, cap, angle, !!outline, h, v, x, y)
  }

  [REPR](depth, options) {
    return `CanvasTexture (${this.ƒ("repr")})`
  }
}


//
// Mime type <-> File extension mappings
//

class Format{
  constructor(){
    let png = "image/png",
        jpg = "image/jpeg",
        jpeg = "image/jpeg",
        webp = "image/webp",
        pdf = "application/pdf",
        svg = "image/svg+xml",
        raw = "application/octet-stream"

    Object.assign(this, {
      toMime: this.toMime.bind(this),
      fromMime: this.fromMime.bind(this),
      expected: `"png", "jpg", "webp", "raw", "pdf", or "svg"`,
      formats: {png, jpg, jpeg, webp, raw, pdf, svg},
      mimes: {[png]: "png", [jpg]: "jpg", [webp]: "webp", [raw]: "raw", [pdf]: "pdf", [svg]: "svg"},
    })
  }

  toMime(ext){
    return this.formats[(ext||'').replace(/^\./, '').toLowerCase()]
  }

  fromMime(mime){
    return this.mimes[mime]
  }
}

//
// Validation of the options dict shared by the `saveAs`, `toBuffer`, and `toDataURL` methods
//

const {basename, extname} = __webpack_require__(71017)

function exportOptions(canvas, {filename='', extension=''}, opts){
  // a single number will be interpreted as a quality setting
  if (typeof opts=='number') opts = {quality:opts}

  // unpack common export options
  let {page, quality, matte, density, msaa, outline, downsample, colorType} = opts

  // only allow format overrides in toFile()
  let imageFormat = !!filename ? opts.format : undefined

  if (filename instanceof URL){
    if (filename.protocol=='file:') filename = fileURLToPath(filename)
    else throw Error(`URLs must use 'file' protocol (got '${filename.protocol.replace(':', '')}')`)
  }

  // ensure the canvas has a context (so it can at least generate an empty image)
  if (!canvas.pages.length) canvas.getContext("2d")

  var {fromMime, toMime, expected} = new Format(),
      ext = imageFormat || extension.replace(/@\d+x$/i,'') || extname(filename),
      format = fromMime(toMime(ext) || ext),
      mime = toMime(format),
      pages = canvas.pages,
      pp = pages.length

  if (!ext) throw new Error(`Cannot determine image format (use a filename extension or 'format' argument)`)
  if (!format) throw new Error(`Unsupported file format "${ext}" (expected ${expected})`)

  let padding, isSequence, pattern = filename.replace(/{(\d*)}/g, (_, width) => {
    isSequence = true
    width = parseInt(width, 10)
    padding = isFinite(width) ? width : isFinite(padding) ? padding : -1
    return "{}"
  })

  // allow negative indexing if a specific page is specified
  let idx = page > 0 ? page - 1
          : page < 0 ? pp + page
          : undefined;

  if (isFinite(idx) && idx < 0 || idx >= pp) throw new RangeError(
    pp == 1 ? `Canvas only has a ‘page 1’ (${idx} is out of bounds)`
            : `Canvas has pages 1–${pp} (${idx} is out of bounds)`
  )

  pages = isFinite(idx) ? [pages[idx]]
        : isSequence || format=='pdf' ? pages
        : pages.slice(-1) // default to the 'current' context

  // inherit text settings from the canvas (since they can't be changed on a per-render basis due to glyph caching)
  const {textContrast, textGamma} = canvas.engine

  if (quality===undefined){
    quality = 0.92
  }else{
    if (typeof quality!='number' || !isFinite(quality) || quality<0 || quality>1){
      throw new TypeError("Expected a number between 0.0–1.0 for `quality`")
    }
  }

  if (density===undefined){
    let m = (extension || basename(filename, ext)).match(/@(\d+)x$/i)
    density = m ? parseInt(m[1], 10) : 1
  }else if (typeof density!='number' || !Number.isInteger(density) || density<1){
    throw new TypeError("Expected a non-negative integer for `density`")
  }

  if (msaa===undefined || msaa===true) {
    msaa = undefined // use the default 4x msaa
  }else if (!isFinite(+msaa) || +msaa<0){
    throw new TypeError("The number of MSAA samples must be an integer ≥0")
  }

  if (colorType!==undefined){
    pixelSize(colorType) // throw an error if invalid
  }

  // default to false, otherwise detect truthy
  downsample = !!downsample
  outline = !!outline

  return {
    filename, pattern, format, mime, pages, padding, quality, matte,
    density, msaa, outline, textContrast, textGamma, downsample, colorType
  }
}

// emit a deprecation warning, once per API per process
let _warnings = {
  "Canvas.saveAs()": "Canvas.toFile()",
  "Canvas.saveAsSync()": "Canvas.toFileSync()",
  "Canvas.toDataURLSync()": "Canvas.toURLSync() (see also Canvas.toDataURL() which is now synchronous)",
}
function _deprecated(oldAPI){
  let newAPI = _warnings[oldAPI]
  if (newAPI) console.error(`Deprecation warning: ${oldAPI} has been renamed to ${newAPI} and will stop working in a future release.`)
  delete _warnings[oldAPI]
}

module.exports = {Canvas, CanvasGradient, CanvasPattern, CanvasTexture, getSharp}


/***/ }),

/***/ 7949:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// The Canvas drawing API
//



const {RustClass, core, wrap, inspect, argc, REPR} = __webpack_require__(7302),
      {Canvas, CanvasGradient, CanvasPattern, CanvasTexture} = __webpack_require__(46155),
      {fromSkMatrix, toSkMatrix} = __webpack_require__(86515),
      {Image, ImageData} = __webpack_require__(39266),
      {TextMetrics} = __webpack_require__(10040),
      {Path2D} = __webpack_require__(24767),
      css = __webpack_require__(44103)

const toString = val => typeof val=='string' ? val : new String(val).toString()

class CanvasRenderingContext2D extends RustClass{
  #canvas

  constructor(canvas){
    try{
      super(CanvasRenderingContext2D).alloc(core(canvas))
      this.#canvas = new WeakRef(canvas)
    }catch(e){
      throw new TypeError(`Function is not a constructor (use Canvas's "getContext" method instead)`)
    }
  }

  get canvas(){ return this.#canvas.deref() }

  // -- global state & content reset ------------------------------------------
  reset(){ this.ƒ('reset') }

  // -- grid state ------------------------------------------------------------
  save(){ this.ƒ('save') }
  restore(){ this.ƒ('restore') }

  get currentTransform(){ return fromSkMatrix( this.prop('currentTransform') ) }
  set currentTransform(matrix){ this.setTransform(matrix) }

  resetTransform(){ this.ƒ('resetTransform')}
  getTransform(){ return this.currentTransform }
  setTransform(matrix){ this.prop('currentTransform', toSkMatrix.apply(null, arguments)) }

  transform(matrix) { this.ƒ('transform', toSkMatrix.apply(null, arguments)) }
  translate(x, y){ this.ƒ('translate', ...arguments)}
  scale(x, y){ this.ƒ('scale', ...arguments)}
  rotate(angle){ this.ƒ('rotate', ...arguments)}

  createProjection(quad, basis){
    return fromSkMatrix(this.ƒ("createProjection", [quad].flat(), [basis].flat()))
  }

  // -- bézier paths ----------------------------------------------------------
  beginPath(){ this.ƒ('beginPath') }
  rect(x, y, width, height){ this.ƒ('rect', ...arguments) }
  arc(x, y, radius, startAngle, endAngle, isCCW){ this.ƒ('arc', ...arguments) }
  ellipse(x, y, xRadius, yRadius, rotation, startAngle, endAngle, isCCW){ this.ƒ('ellipse', ...arguments) }
  moveTo(x, y){ this.ƒ('moveTo', ...arguments) }
  lineTo(x, y){ this.ƒ('lineTo', ...arguments) }
  arcTo(x1, y1, x2, y2, radius){ this.ƒ('arcTo', ...arguments) }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this.ƒ('bezierCurveTo', ...arguments) }
  quadraticCurveTo(cpx, cpy, x, y){ this.ƒ('quadraticCurveTo', ...arguments) }
  conicCurveTo(cpx, cpy, x, y, weight){ this.ƒ("conicCurveTo", ...arguments) }
  closePath(){ this.ƒ('closePath') }
  roundRect(x, y, w, h, r=0){
    argc(arguments, 4, 5)
    let radii = css.radii(r)
    if (radii){
      if (w < 0) radii = [radii[1], radii[0], radii[3], radii[2]]
      if (h < 0) radii = [radii[3], radii[2], radii[1], radii[0]]
      this.ƒ("roundRect", x, y, w, h, ...radii.map(({x, y}) => [x, y]).flat())
    }
  }


  // -- using paths -----------------------------------------------------------
  fill(path, rule){
    if (path instanceof Path2D) arguments[0] = core(path)
    return this.ƒ('fill', ...arguments)
  }

  stroke(path){
    if (path instanceof Path2D) arguments[0] = core(path)
    return this.ƒ('stroke', ...arguments)
  }

  clip(path, rule){
    if (path instanceof Path2D) arguments[0] = core(path)
    return this.ƒ('clip', ...arguments)
  }

  isPointInPath(path, x, y, rule){
    if (path instanceof Path2D) arguments[0] = core(path)
    return this.ƒ('isPointInPath', ...arguments)
  }
  isPointInStroke(path, x, y){
    if (path instanceof Path2D) arguments[0] = core(path)
    return this.ƒ('isPointInStroke', ...arguments)
  }


  // -- shaders ---------------------------------------------------------------
  createPattern(image, repetition){ return new CanvasPattern(this.canvas, ...arguments) }
  createLinearGradient(x0, y0, x1, y1){
    return new CanvasGradient("Linear", ...arguments)
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1){
    return new CanvasGradient("Radial", ...arguments)
  }
  createConicGradient(startAngle, x, y){
    return new CanvasGradient("Conic", ...arguments)
  }

  createTexture(spacing, options){
    return new CanvasTexture(...arguments)
  }

  // -- fill & stroke ---------------------------------------------------------
  fillRect(x, y, width, height){ this.ƒ('fillRect', ...arguments) }
  strokeRect(x, y, width, height){ this.ƒ('strokeRect', ...arguments) }
  clearRect(x, y, width, height){ this.ƒ('clearRect', ...arguments) }

  set fillStyle(style){
    let isShader = style instanceof CanvasPattern || style instanceof CanvasGradient || style instanceof CanvasTexture,
        [ref, val] = isShader ? [style, core(style)] : [null, style]
    this.ref('fill', ref)
    this.prop('fillStyle', val)
  }

  get fillStyle(){
    let style = this.prop('fillStyle')
    return style===null ? this.ref('fill') : style
  }

  set strokeStyle(style){
    let isShader = style instanceof CanvasPattern || style instanceof CanvasGradient || style instanceof CanvasTexture,
        [ref, val] = isShader ? [style, core(style)] : [null, style]
    this.ref('stroke', ref)
    this.prop('strokeStyle', val)
  }

  get strokeStyle(){
    let style = this.prop('strokeStyle')
    return style===null ? this.ref('stroke') : style
  }

  // -- line style ------------------------------------------------------------
  getLineDash(){        return this.ƒ("getLineDash") }
  setLineDash(segments){       this.ƒ("setLineDash", ...arguments) }
  get lineCap(){        return this.prop("lineCap") }
  set lineCap(style){          this.prop("lineCap", style) }
  get lineDashFit(){    return this.prop("lineDashFit") }
  set lineDashFit(style){      this.prop("lineDashFit", style) }
  get lineDashMarker(){ return wrap(Path2D, this.prop("lineDashMarker")) }
  set lineDashMarker(path){    this.prop("lineDashMarker", path instanceof Path2D ? core(path) : path) }
  get lineDashOffset(){ return this.prop("lineDashOffset") }
  set lineDashOffset(offset){  this.prop("lineDashOffset", offset) }
  get lineJoin(){       return this.prop("lineJoin") }
  set lineJoin(style){         this.prop("lineJoin", style) }
  get lineWidth(){      return this.prop("lineWidth") }
  set lineWidth(width){        this.prop("lineWidth", width) }
  get miterLimit(){     return this.prop("miterLimit") }
  set miterLimit(limit){       this.prop("miterLimit", limit) }

  // -- imagery ---------------------------------------------------------------
  get imageSmoothingEnabled(){ return this.prop("imageSmoothingEnabled")}
  set imageSmoothingEnabled(flag){    this.prop("imageSmoothingEnabled", !!flag)}
  get imageSmoothingQuality(){ return this.prop("imageSmoothingQuality")}
  set imageSmoothingQuality(level){   this.prop("imageSmoothingQuality", level)}

  createImageData(width, height, settings){
    argc(arguments, 2, 3)
    return new ImageData(width, height, settings)
  }

  getImageData(x, y, width, height, {colorType='rgba', colorSpace='srgb', density=1, matte, msaa}={}){
    argc(arguments, 4, 5)

    if (typeof density!='number' || !Number.isInteger(density) || density<1){
      throw new TypeError("Expected a non-negative integer for `density`")
    }

    if (msaa===undefined || msaa===true) {
      msaa = undefined // use the default 4x msaa
    }else if (!isFinite(+msaa) || +msaa<0){
      throw new TypeError("The number of MSAA samples must be an integer ≥0")
    }

    let opts = {colorType, colorSpace, density, matte, msaa},
        buffer = this.ƒ('getImageData', x, y, width, height, opts, core(this.canvas));
    return new ImageData(buffer, width*density, height*density, {colorType, colorSpace})
  }

  putImageData(imageData, ...coords){
    argc(arguments, 3, 7)
    if (!(imageData instanceof ImageData)) throw TypeError("Expected an ImageData as 1st arg")
    this.ƒ('putImageData', imageData, ...coords)
  }

  drawImage(image, ...coords){
    if (image instanceof Canvas){
      this.ƒ('drawImage', core(image.getContext('2d')), ...coords)
    }else if (image instanceof Image){
      if (image.complete) this.ƒ('drawImage', core(image), ...coords)
      else throw Error("Image has not completed loading: listen for `load` event or await `decode()` first")
    }else if (image instanceof ImageData){
      this.ƒ('drawImage', image, ...coords)
    }else if (image instanceof Promise) {
      throw Error("Promise has not yet resolved: `await` image loading before drawing")
    }else{
      let nonimage = inspect(image, {depth:1})
      throw Error(`Expected an Image or a Canvas argument (got: ${nonimage})`)
    }
  }

  drawCanvas(image, ...coords){
    if (image instanceof Canvas){
      this.ƒ('drawCanvas', core(image.getContext('2d')), ...coords)
    }else{
      this.drawImage(image, ...coords)
    }
  }

  // -- typography ------------------------------------------------------------
  get font(){          return this.prop('font') }
  set font(str){              this.prop('font', css.font(str)) }
  get textAlign(){     return this.prop("textAlign") }
  set textAlign(mode){        this.prop("textAlign", mode) }
  get textBaseline(){  return this.prop("textBaseline") }
  set textBaseline(mode ){    this.prop("textBaseline", mode) }
  get direction(){     return this.prop("direction") }
  set direction(mode){        this.prop("direction", mode) }
  get fontStretch(){   return this.prop('fontStretch') }
  set fontStretch(str){       this.prop('fontStretch', css.stretch(str)) }
  get letterSpacing(){ return this.prop('letterSpacing') }
  set letterSpacing(str){     this.prop('letterSpacing', css.spacing(str)) }
  get wordSpacing(){   return this.prop('wordSpacing') }
  set wordSpacing(str){       this.prop('wordSpacing', css.spacing(str)) }

  measureText(text, maxWidth){
    let metrics = JSON.parse(this.ƒ('measureText', toString(text), maxWidth))
    return new TextMetrics(metrics)
  }

  fillText(text, ...geom){
    this.ƒ('fillText', toString(text), ...geom)
  }

  strokeText(text, ...geom){
    this.ƒ('strokeText', toString(text), ...geom)
  }

  outlineText(text, ...geom){
    let path = this.ƒ('outlineText', toString(text), ...geom)
    return path ? wrap(Path2D, path) : null
  }

  // -- non-standard typography extensions --------------------------------------------
  get fontHinting(){    return this.prop("fontHinting") }
  set fontHinting(flag){       this.prop("fontHinting", !!flag) }
  get fontVariant(){    return this.prop('fontVariant') }
  set fontVariant(str){        this.prop('fontVariant', css.variant(str)) }
  get textWrap(){       return this.prop("textWrap") }
  set textWrap(flag){          this.prop("textWrap", !!flag) }
  get textDecoration(){ return this.prop("textDecoration") }
  set textDecoration(str){     this.prop("textDecoration", css.decoration(str)) }
  set textTracking(_){
    process.emitWarning("The .textTracking property has been removed; use the .letterSpacing property instead", "PropertyRemoved")
  }

  // -- effects ---------------------------------------------------------------
  get globalCompositeOperation(){ return this.prop("globalCompositeOperation") }
  set globalCompositeOperation(blend){   this.prop("globalCompositeOperation", blend) }
  get globalAlpha(){   return this.prop("globalAlpha") }
  set globalAlpha(alpha){     this.prop("globalAlpha", alpha) }
  get shadowBlur(){    return this.prop("shadowBlur") }
  set shadowBlur(level){      this.prop("shadowBlur", level) }
  get shadowColor(){   return this.prop("shadowColor") }
  set shadowColor(color){     this.prop("shadowColor", color) }
  get shadowOffsetX(){ return this.prop("shadowOffsetX") }
  set shadowOffsetX(x){       this.prop("shadowOffsetX", x) }
  get shadowOffsetY(){ return this.prop("shadowOffsetY") }
  set shadowOffsetY(y){       this.prop("shadowOffsetY", y) }
  get filter(){        return this.prop('filter') }
  set filter(str){            this.prop('filter', css.filter(str)) }

  [REPR](depth, options) {
    let props = [ "canvas", "currentTransform", "fillStyle", "strokeStyle", "font", "fontStretch", "fontVariant",
                  "direction", "textAlign", "textBaseline", "textWrap", "letterSpacing", "wordSpacing", "globalAlpha",
                  "globalCompositeOperation", "imageSmoothingEnabled", "imageSmoothingQuality", "filter",
                  "shadowBlur", "shadowColor", "shadowOffsetX", "shadowOffsetY", "lineCap", "lineDashOffset",
                  "lineJoin", "lineWidth", "miterLimit" ]
    let info = {}
    if (depth > 0 ){
      for (var prop of props){
        try{ info[prop] = this[prop] }
        catch{ info[prop] = undefined }
      }
    }
    return `CanvasRenderingContext2D ${inspect(info, options)}`
  }
}

module.exports = {CanvasRenderingContext2D}


/***/ }),

/***/ 44103:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Parsers for properties that take CSS-style strings as values
//



// -- Font & Variant --------------------------------------------------------------------
//    https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant
//    https://www.w3.org/TR/css-fonts-3/#font-size-prop

var splitBy = __webpack_require__(94975),
    m, cache = {font:{}, variant:{}};

const styleRE = /^(normal|italic|oblique)$/,
      smallcapsRE = /^(normal|small-caps)$/,
      stretchRE = /^(normal|(semi-|extra-|ultra-)?(condensed|expanded))$/,
      namedSizeRE = /(?:xx?-)?small|smaller|medium|larger|(?:xx?-)?large|normal/,
      numSizeRE = /^(\-?[\d\.]+)(px|pt|pc|in|cm|mm|%|em|ex|ch|rem|q)/,
      namedWeightRE = /^(normal|bold(er)?|lighter)$/,
      numWeightRE = /^(1000|\d{1,3})$/,
      parameterizedRE = /([\w\-]+)\((.*?)\)/,
      unquote = s => s.replace(/^(['"])(.*?)\1$/, "$2"),
      isSize = s => namedSizeRE.test(s) || numSizeRE.test(s),
      isWeight = s => namedWeightRE.test(s) || numWeightRE.test(s);

function parseFont(str){
  if (cache.font[str]===undefined){
    try{
      if (typeof str !== 'string') throw new Error('Font specification must be a string')
      if (!str) throw new Error('Font specification cannot be an empty string')

      let font = {style:'normal', variant:'normal', weight:'normal', stretch:'normal'},
          value = str.replace(/\s*\/\*s/, "/"),
          tokens = splitBy(value, /\s+/),
          token;

      while (token = tokens.shift()) {
        let match = styleRE.test(token) ? 'style'
                  : smallcapsRE.test(token) ? 'variant'
                  : stretchRE.test(token) ? 'stretch'
                  : isWeight(token) ? 'weight'
                  : isSize(token) ? 'size'
                  : null;

        switch (match){
          case "style":
          case "variant":
          case "stretch":
          case "weight":
            font[match] = token
            break;

          case "size":
            // size is the pivot point between the style fields and the family name stack,
            // so start processing what's been collected
            let [emSize, leading] = splitBy(token, '/'),
                size = parseSize(emSize),
                lineHeight = leading ? parseSize(leading.replace(/(\d)$/, '$1em'), size) : undefined,
                weight = parseWeight(font.weight),
                family = splitBy(tokens.join(' '), /\s*,\s*/).map(unquote),
                features = font.variant=='small-caps' ? {on:['smcp', 'onum']} : {},
                {style, stretch, variant} = font;

            // make sure all the numeric fields have legitimate values
            let invalid = !isFinite(size) ? `font size "${emSize}"`
                        : !isFinite(lineHeight) && lineHeight!==undefined ? `line height "${leading}"`
                        : !isFinite(weight) ? `font weight "${font.weight}"`
                        : family.length==0 ? `font family "${tokens.join(', ')}"`
                        : false;

            if (!invalid){
              // include a re-stringified version of the decoded/absified values
              return cache.font[str] = Object.assign(font, {
                size, lineHeight, weight, family, features,
                canonical:[
                  style,
                  (variant !== style) && variant,
                  ([variant, style].indexOf(weight) == -1) && weight,
                  ([variant, style, weight].indexOf(stretch) == -1) && stretch,
                  `${size}px${isFinite(lineHeight) ? `/${lineHeight}px`: ''}`,
                  family.map(nm => nm.match(/\s/) ? `"${nm}"` : nm).join(", ")
                ].filter(Boolean).join(' ')
              })
            }
            throw new Error(`Invalid ${invalid}`)

          default:
            throw new Error(`Unrecognized font attribute "${token}"`)
        }
      }
      throw new Error('Could not find a font size value')
    } catch(e) {
      // console.warn(Object.assign(e, {name:"Warning"}))
      cache.font[str] = null
    }
  }
  return cache.font[str]
}

function parseSize(str, emSize=16){
  if (m = numSizeRE.exec(str)){
    let [size, unit] = [parseFloat(m[1]), m[2]]
    return size * (unit == 'px' ? 1
                :  unit == 'pt' ? 1 / 0.75
                :  unit == '%' ? emSize / 100
                :  unit == 'pc' ? 16
                :  unit == 'in' ? 96
                :  unit == 'cm' ? 96.0 / 2.54
                :  unit == 'mm' ? 96.0 / 25.4
                :  unit == 'q' ? 96 / 25.4 / 4
                :  unit.match('r?em') ? emSize
                :  NaN )
  }

  if (m = namedSizeRE.exec(str)){
    return emSize * (sizeMap[m[0]] || 1.0)
  }

  return NaN
}

function parseFlexibleSize(str){
  if (m = numSizeRE.exec(str)){
    let [size, unit] = [parseFloat(m[1]), m[2]],
        px = size * (unit == 'px' ? 1
          :  unit == 'pt' ? 1 / 0.75
          :  unit == 'pc' ? 16
          :  unit == 'in' ? 96
          :  unit == 'cm' ? 96.0 / 2.54
          :  unit == 'mm' ? 96.0 / 25.4
          :  unit == 'q' ? 96 / 25.4 / 4
          :  NaN )
    return {size, unit, px}
  }
  return null
}

function parseStretch(str){
  return (m = stretchRE.exec(str)) ? m[0] : undefined
}

function parseWeight(str){
  return (m = numWeightRE.exec(str)) ? parseInt(m[0]) || NaN
       : (m = namedWeightRE.exec(str)) ? weightMap[m[0]]
       : NaN
}

function parseVariant(str){
  if (cache.variant[str]===undefined){
    let variants = [],
        features = {on:[], off:[]};

    for (let token of splitBy(str, /\s+/)){
      if (token == 'normal'){
        return {variants:[token], features:{on:[], off:[]}}
      }else if (token in featureMap){
        featureMap[token].forEach(feat => {
          if (feat[0] == '-') features.off.push(feat.slice(1))
          else features.on.push(feat)
        })
        variants.push(token);
      }else if (m = parameterizedRE.exec(token)){
        let subPattern = alternatesMap[m[1]],
            subValue = Math.max(0, Math.min(99, parseInt(m[2], 10))),
            [feat, val] = subPattern.replace(/##/, subValue < 10 ? '0'+subValue : subValue)
                             .replace(/#/, Math.min(9, subValue)).split(' ');
        if (typeof val=='undefined') features.on.push(feat)
        else features[feat] = parseInt(val, 10)
        variants.push(`${m[1]}(${subValue})`)
      }else{
        throw new Error(`Invalid font variant "${token}"`)
      }
    }

    cache.variant[str] = {variant:variants.join(' '), features:features};
  }

  return cache.variant[str];
}


function parseTextDecoration(str){
  let style = 'solid',
      line = 'none',
      color = 'currentColor',
      inherit = 'auto',
      thickness,
      _val

  str =  (typeof str=='string' ? str : '').trim().replace(/\s+/, ' ')
  for (const token of str.split(' ')){
    if (token.match(/solid|double|dotted|dashed|wavy/)) style = token
    else if (token.match(/none|initial|revert(-layer)?|unset/)) line = "none"
    else if (token.match(/underline|overline|line-through/)) line = token
    else if (_val = parseFlexibleSize(token)) thickness = _val
    else if (token.match(/auto|from-font/)) inherit = token
    else color = token
  }

  return { style, line, color, thickness, inherit, str }
}


// -- Window Types -----------------------------------------------------------------------

let cursorTypes = [
  "default", "none", "context-menu", "help", "pointer", "progress", "wait", "cell", "crosshair",
  "text", "vertical-text", "alias", "copy", "move", "no-drop", "not-allowed", "grab", "grabbing",
  "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize",
  "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "col-resize", "row-resize", "all-scroll",
  "zoom-in", "zoom-out",
]

function parseCursor(str){
  return cursorTypes.includes(str)
}

function parseFit(mode){
  return ["none", "contain-x", "contain-y", "contain", "cover", "fill", "scale-down", "resize"].includes(mode)
}

// -- Corner Rounding
//    https://github.com/fserb/canvas2D/blob/master/spec/roundrect.md

function parseCornerRadii(r){
  r = [r].flat()
         .slice(0, 4)
         .map(n => n && Object.hasOwn(n, 'x') && Object.hasOwn(n, 'y') ? n : {x:n, y:n})

  if (r.some(pt => !Number.isFinite(pt.x) || !Number.isFinite(pt.y))){
    return null // silently abort
  }else if (r.some(pt => pt.x < 0 || pt.y < 0)){
    throw RangeError("Corner radius cannot be negative")
  }

  return r.length == 1 ? [r[0], r[0], r[0], r[0]]
       : r.length == 2 ? [r[0], r[1], r[0], r[1]]
       : r.length == 3 ? [r[0], r[1], r[2], r[1]]
       : r.length == 4 ? [r[0], r[1], r[2], r[3]]
       : [0, 0, 0, 0].map(n => ({x:n, y:n}))
}

// -- Image Filters -----------------------------------------------------------------------
//    https://developer.mozilla.org/en-US/docs/Web/CSS/filter

var plainFilterRE = /(blur|hue-rotate|brightness|contrast|grayscale|invert|opacity|saturate|sepia)\((.*?)\)/,
    shadowFilterRE = /drop-shadow\((.*)\)/,
    percentValueRE = /^(\+|-)?\d+%$/,
    angleValueRE = /([\d\.]+)(deg|g?rad|turn)/;

function parseFilter(str){
  let filters = {}
  let canonical = []

  for (var spec of splitBy(str, /\s+/) || []){
    if (m = shadowFilterRE.exec(spec)){
      let kind = 'drop-shadow',
          args = m[1].trim().split(/\s+/),
          lengths = args.slice(0,3),
          color = args.slice(3).join(' '),
          dims = lengths.map(s => parseSize(s)).filter(isFinite);
      if (dims.length==3 && !!color){
        filters[kind] = [...dims, color]
        canonical.push(`${kind}(${lengths.join(' ')} ${color.replace(/ /g,'')})`)
      }
    }else if (m = plainFilterRE.exec(spec)){
      let [kind, arg] = m.slice(1)
      let val = kind=='blur' ? parseSize(arg)
              : kind=='hue-rotate' ? parseAngle(arg)
              : parsePercentage(arg);
      if (isFinite(val)){
        filters[kind] = val
        canonical.push(`${kind}(${arg.trim()})`)
      }
    }
  }

  return str.trim() == 'none' ? {canonical:'none', filters}
       : canonical.length ? {canonical:canonical.join(' '), filters}
       : null
}

function parsePercentage(str){
  return percentValueRE.test(str.trim()) ? parseInt(str, 10) / 100
       : !isNaN(str) ? parseFloat(str)
       : NaN
}

function parseAngle(str){
  if (m = angleValueRE.exec(str.trim())){
    let [amt, unit] = [parseFloat(m[1]), m[2]]
    return unit== 'deg' ? amt
         : unit== 'rad' ? 360 * amt / (2 * Math.PI)
         : unit=='grad' ? 360 * amt / 400
         : unit=='turn' ? 360 * amt
         : NaN
  }
}

//
// Font attribute keywords & corresponding values
//

const weightMap = {
  "lighter":300,
  "normal":400,
  "bold":700,
  "bolder":800
}

const sizeMap = {
  "xx-small":3/5,
  "x-small":3/4,
  "small":8/9,
  "smaller":8/9,
  "large":6/5,
  "larger":6/5,
  "x-large":3/2,
  "xx-large":2/1,
  "normal": 1.2 // special case for lineHeight
}

const featureMap = {
  "normal": [],

  // font-variant-ligatures
  "common-ligatures": ["liga", "clig"],
  "no-common-ligatures": ["-liga", "-clig"],
  "discretionary-ligatures": ["dlig"],
  "no-discretionary-ligatures": ["-dlig"],
  "historical-ligatures": ["hlig"],
  "no-historical-ligatures": ["-hlig"],
  "contextual": ["calt"],
  "no-contextual": ["-calt"],

  // font-variant-position
  "super": ["sups"],
  "sub": ["subs"],

  // font-variant-caps
  "small-caps": ["smcp"],
  "all-small-caps": ["c2sc", "smcp"],
  "petite-caps": ["pcap"],
  "all-petite-caps": ["c2pc", "pcap"],
  "unicase": ["unic"],
  "titling-caps": ["titl"],

  // font-variant-numeric
  "lining-nums": ["lnum"],
  "oldstyle-nums": ["onum"],
  "proportional-nums": ["pnum"],
  "tabular-nums": ["tnum"],
  "diagonal-fractions": ["frac"],
  "stacked-fractions": ["afrc"],
  "ordinal": ["ordn"],
  "slashed-zero": ["zero"],

  // font-variant-east-asian
  "jis78": ["jp78"],
  "jis83": ["jp83"],
  "jis90": ["jp90"],
  "jis04": ["jp04"],
  "simplified": ["smpl"],
  "traditional": ["trad"],
  "full-width": ["fwid"],
  "proportional-width": ["pwid"],
  "ruby": ["ruby"],

  // font-variant-alternates (non-parameterized)
  "historical-forms": ["hist"],
}

const alternatesMap = {
  "stylistic": "salt #",
  "styleset": "ss##",
  "character-variant": "cv##",
  "swash": "swsh #",
  "ornaments": "ornm #",
  "annotation": "nalt #",
}

module.exports = {
  // used by context
  font:parseFont,
  variant:parseVariant,
  size:parseSize,
  spacing:parseFlexibleSize,
  stretch:parseStretch,
  decoration:parseTextDecoration,
  filter:parseFilter,

  // path & context
  radii:parseCornerRadii,

  // gui
  cursor:parseCursor,
  fit:parseFit,
}


/***/ }),

/***/ 86515:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Polyfill for DOMMatrix and friends
//



const {inspect} = __webpack_require__(73837)

const isPlainObject = o => (
  o !== null &&
  typeof o === "object" &&
  !(o instanceof DOMMatrix) &&
  !Array.isArray(o) &&
  !ArrayBuffer.isView(o)
)

/*
 * vendored in order to fix its dependence on the window global [@samizdatco 2020/08/04]
 * removed SVGMatrix references that were guaranteed to be undefined on node [@mpaperno 2024/10/20]
 * added support for parsing existing matrices (and matrix-like) objects in constructor [@mpaperno 2024/10/20]
 * added `parseTransform*` helpers to enable CSS-style strings as constructor args [@samizdatco 2024/10/29]
 * otherwise unchanged from https://github.com/jarek-foksa/geometry-polyfill/tree/f36bbc8f4bc43539d980687904ce46c8e915543d
 */

// @info
//   DOMPoint polyfill
// @src
//   https://drafts.fxtf.org/geometry/#DOMPoint
//   https://github.com/chromium/chromium/blob/master/third_party/blink/renderer/core/geometry/dom_point_read_only.cc
class DOMPoint {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  static fromPoint(otherPoint) {
    return new DOMPoint(
      otherPoint.x,
      otherPoint.y,
      otherPoint.z !== undefined ? otherPoint.z : 0,
      otherPoint.w !== undefined ? otherPoint.w : 1
    );
  }

  matrixTransform(matrix) {
    if (
      matrix.is2D &&
      this.z === 0 &&
      this.w === 1
    ) {
      return new DOMPoint(
        this.x * matrix.a + this.y * matrix.c + matrix.e,
        this.x * matrix.b + this.y * matrix.d + matrix.f,
        0, 1
      );
    }
    else {
      return new DOMPoint(
        this.x * matrix.m11 + this.y * matrix.m21 + this.z * matrix.m31 + this.w * matrix.m41,
        this.x * matrix.m12 + this.y * matrix.m22 + this.z * matrix.m32 + this.w * matrix.m42,
        this.x * matrix.m13 + this.y * matrix.m23 + this.z * matrix.m33 + this.w * matrix.m43,
        this.x * matrix.m14 + this.y * matrix.m24 + this.z * matrix.m34 + this.w * matrix.m44
      );
    }
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      w: this.w
    };
  }
}


// @info
//   DOMRect polyfill
// @src
//   https://drafts.fxtf.org/geometry/#DOMRect
//   https://github.com/chromium/chromium/blob/master/third_party/blink/renderer/core/geometry/dom_rect_read_only.cc

class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  static fromRect(otherRect) {
    return new DOMRect(otherRect.x, otherRect.y, otherRect.width, otherRect.height);
  }

  get top() {
    return this.y;
  }

  get left() {
    return this.x;
  }

  get right() {
    return this.x + this.width;
  }

  get bottom() {
    return this.y + this.height;
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      top: this.top,
      left: this.left,
      right: this.right,
      bottom: this.bottom
    };
  }
}

for (let propertyName of ["top", "right", "bottom", "left"]) {
  let propertyDescriptor = Object.getOwnPropertyDescriptor(DOMRect.prototype, propertyName);
  propertyDescriptor.enumerable = true;
  Object.defineProperty(DOMRect.prototype, propertyName, propertyDescriptor);
}



// @info
//   DOMMatrix polyfill (SVG 2)
// @src
//   https://github.com/chromium/chromium/blob/master/third_party/blink/renderer/core/geometry/dom_matrix_read_only.cc
//   https://github.com/tocharomera/generativecanvas/blob/master/node-canvas/lib/DOMMatrix.js

const M11 =  0,  M12 =  1,  M13 =  2,  M14 =  3;
const M21 =  4,  M22 =  5,  M23 =  6,  M24 =  7;
const M31 =  8,  M32 =  9,  M33 = 10,  M34 = 11;
const M41 = 12,  M42 = 13,  M43 = 14,  M44 = 15;

const A = M11, B = M12;
const C = M21, D = M22;
const E = M41, F = M42;

const DEGREE_PER_RAD = 180 / Math.PI;
const RAD_PER_DEGREE = Math.PI / 180;

const $values = Symbol();
const $is2D = Symbol();

// Parsers for CSS-style string initializers
const parseTransformName = name => (
   name.match(/^(matrix(3d)?|(rotate|translate|scale)(3d|X|Y|Z)?|skew(X|Y)?)$/)
)

const parseAngle = value => {
  if (value.endsWith('deg')) return parseFloat(value)
  if (value.endsWith('rad')) return parseFloat(value)/Math.PI * 180
  if (value.endsWith('turn')) return parseFloat(value) * 360
  throw new TypeError(`Angles must be in 'deg', 'rad', or 'turn' units (got: "${value}")`)
}

const parseLength = value => {
  if (value.endsWith('px')) return parseFloat(value)
  if (!isNaN(value) && !isNaN(parseFloat(value))) return parseFloat(value)
  throw new TypeError(`Lengths must be in 'px' or numeric units (got: "${value}")`)
}

const parseScalar = value => {
  if (value.endsWith('%')) return parseFloat(value) / 100
  if (!isNaN(value) && !isNaN(parseFloat(value))) return parseFloat(value)
  throw new TypeError(`Scales must be in '%' or numeric units (got: "${value}")`)
}

const parseNumeric = value => {
  if (!isNaN(value) && !isNaN(parseFloat(value))) return parseFloat(value)
  throw new TypeError(`Matrix values must be in plain, numeric units (got: "${value}")`)
}

const parseTransformString = (transformString) => {
  return transformString
    .split(/\)\s*?/)
    .filter(s => !!s.trim())
    .map(transform => {
      let [name, transformValue] = transform.split('(').map(s => s.trim())

      // catch single-word initializers
      if (!transformValue){
        if (name.match(/^(inherit|initial|revert(-layer)?|unset|none)$/)) return {op:'matrix', vals:[1,0,0,1,0,0] }
        throw new SyntaxError("The string did not match the expected pattern")
      }

      // otherwise check that the last term was well formed before splitting based on `)`
      if (!transformString.trim().endsWith(')')){
        throw new SyntaxError("Expected a closing ')'")
      }

      // validate & normalize op names
      if (!parseTransformName(name)){
        throw new SyntaxError(`Unknown transform operation: ${name}`)
      }else if (name=='rotate3d'){
        name = 'rotateAxisAngle'
      }

      // validate the individual values & units
      const rawVals = transformValue.split(',').map(s => s.trim())
      const values = name.startsWith('rotate') ? [
        ...rawVals.slice(0,-1).map(parseLength), parseAngle(rawVals.at(-1))
      ] : name.startsWith('skew') ? rawVals.map(parseAngle)
        : name.startsWith('scale') ? rawVals.map(parseScalar)
        : name.startsWith('matrix') ? rawVals.map(parseNumeric)
        : rawVals.map(parseLength)

      // special case validation for the matrix/3d ops
      for (const [form, len] of [['matrix', 6], ['matrix3d', 16]]){
        if (name==form && values.length!=len){
          throw new TypeError(`${name}() requires 6 numeric values (got ${values.length})`)
        }
      }

      // catch single-dimension ops and route them to the corresponding 3D matrix method
      const parts = name.match(/^(rotate|translate|scale)(3d|X|Y|Z)$/)
      if (parts){
        const [_, op, dim] = parts
        const fill = op=='scale' ? 1 : 0
        return {op, vals: dim=='X'? [values[0], fill, fill] :
                          dim=='Y'? [fill, values[0], fill] :
                          dim=='Z'? [fill, fill, values[0]] :
                          values}
      }else{
        return {op:name, vals:values}
      }
    }).flat()
}

let setNumber2D = (receiver, index, value) => {
  if (typeof value !== "number") {
    throw new TypeError("Expected number");
  }

  receiver[$values][index] = value;
};

let setNumber3D = (receiver, index, value) => {
  if (typeof value !== "number") {
    throw new TypeError("Expected number");
  }

  if (index === M33 || index === M44) {
    if (value !== 1) {
      receiver[$is2D] = false;
    }
  }
  else if (value !== 0) {
    receiver[$is2D] = false;
  }

  receiver[$values][index] = value;
};

let newInstance = (values) => {
  let instance = Object.create(DOMMatrix.prototype);
  instance.constructor = DOMMatrix;
  instance[$is2D] = true;
  instance[$values] = values;

  return instance;
};

let multiply = (first, second) => {
  let dest = new Float64Array(16);

  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;

      for (let k = 0; k < 4; k++) {
        sum += first[i * 4 + k] * second[k * 4 + j];
      }

      dest[i * 4 + j] = sum;
    }
  }

  return dest;
};

class DOMMatrix {
  get m11() { return this[$values][M11]; } set m11(value) { setNumber2D(this, M11, value); }
  get m12() { return this[$values][M12]; } set m12(value) { setNumber2D(this, M12, value); }
  get m13() { return this[$values][M13]; } set m13(value) { setNumber3D(this, M13, value); }
  get m14() { return this[$values][M14]; } set m14(value) { setNumber3D(this, M14, value); }
  get m21() { return this[$values][M21]; } set m21(value) { setNumber2D(this, M21, value); }
  get m22() { return this[$values][M22]; } set m22(value) { setNumber2D(this, M22, value); }
  get m23() { return this[$values][M23]; } set m23(value) { setNumber3D(this, M23, value); }
  get m24() { return this[$values][M24]; } set m24(value) { setNumber3D(this, M24, value); }
  get m31() { return this[$values][M31]; } set m31(value) { setNumber3D(this, M31, value); }
  get m32() { return this[$values][M32]; } set m32(value) { setNumber3D(this, M32, value); }
  get m33() { return this[$values][M33]; } set m33(value) { setNumber3D(this, M33, value); }
  get m34() { return this[$values][M34]; } set m34(value) { setNumber3D(this, M34, value); }
  get m41() { return this[$values][M41]; } set m41(value) { setNumber2D(this, M41, value); }
  get m42() { return this[$values][M42]; } set m42(value) { setNumber2D(this, M42, value); }
  get m43() { return this[$values][M43]; } set m43(value) { setNumber3D(this, M43, value); }
  get m44() { return this[$values][M44]; } set m44(value) { setNumber3D(this, M44, value); }

  get a() { return this[$values][A]; } set a(value) { setNumber2D(this, A, value); }
  get b() { return this[$values][B]; } set b(value) { setNumber2D(this, B, value); }
  get c() { return this[$values][C]; } set c(value) { setNumber2D(this, C, value); }
  get d() { return this[$values][D]; } set d(value) { setNumber2D(this, D, value); }
  get e() { return this[$values][E]; } set e(value) { setNumber2D(this, E, value); }
  get f() { return this[$values][F]; } set f(value) { setNumber2D(this, F, value); }

  get is2D() {
    return this[$is2D];
  }

  get isIdentity() {
    let values = this[$values];

    return values[M11] === 1 && values[M12] === 0 && values[M13] === 0 && values[M14] === 0 &&
            values[M21] === 0 && values[M22] === 1 && values[M23] === 0 && values[M24] === 0 &&
            values[M31] === 0 && values[M32] === 0 && values[M33] === 1 && values[M34] === 0 &&
            values[M41] === 0 && values[M42] === 0 && values[M43] === 0 && values[M44] === 1;
  }

  static fromMatrix(init) {
    if (init instanceof DOMMatrix)
      return new DOMMatrix(init[$values]);
    if (DOMMatrix.isMatrix4(init))
      return new DOMMatrix([
        init.m11, init.m12, init.m13, init.m14,
        init.m21, init.m22, init.m23, init.m24,
        init.m31, init.m32, init.m33, init.m34,
        init.m41, init.m42, init.m43, init.m44,
      ]);
    if (DOMMatrix.isMatrix3(init) || isPlainObject(init)){
      let {a=1, b=0, c=0, d=1, e=0, f=0} = init
      return new DOMMatrix([a, b, c, d, e, f]);
    }
    throw new TypeError(`Expected DOMMatrix, got: '${init}'`);
  }

  static fromFloat32Array(init) {
    if (!(init instanceof Float32Array)) throw new TypeError("Expected Float32Array");
    return new DOMMatrix(init);
  }

  static fromFloat64Array(init) {
    if (!(init instanceof Float64Array)) throw new TypeError("Expected Float64Array");
    return new DOMMatrix(init);
  }

  static isMatrix3(matrix) {
    if (matrix instanceof DOMMatrix)
      return true;
    if (typeof matrix != 'object')
      return false;
    for (const p of ["a", "b", "c", "d", "e", "f"])
      if (typeof matrix[p] != 'number')
        return false;
    return true;
  }

  static isMatrix4(matrix) {
    if (matrix instanceof DOMMatrix)
      return true;
    if (typeof matrix != 'object')
      return false;
    for (const p of [
      "m11", "m12", "m13", "m14",
      "m21", "m22", "m23", "m24",
      "m31", "m32", "m33", "m34",
      "m41", "m42", "m43", "m44",
    ]) {
      if (typeof matrix[p] != 'number')
        return false;
    }
    return true;
  }

  // @type
  // (Float64Array) => void
  constructor(init) {

    if (init instanceof DOMMatrix || isPlainObject(init))
      return DOMMatrix.fromMatrix(init);

    if (arguments.length > 1)
      init = [...arguments];

    this[$is2D] = true;

    this[$values] = new Float64Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ]);

    // Parse CSS transformList and accumulate transforms sequentially
    if (typeof init === "string") {
      if (init === "") return;

      let acc = new DOMMatrix()
      for (const {op, vals} of parseTransformString(init)) {
        acc = op.startsWith('matrix')
              ? acc.multiply(new DOMMatrix(vals))
              : acc[op] ? acc[op](...vals)
              : acc
      }

      init = acc[$values]
    }

    let i = 0;

    if (init && init.length === 6) {
      setNumber2D(this, A, init[i++]);
      setNumber2D(this, B, init[i++]);
      setNumber2D(this, C, init[i++]);
      setNumber2D(this, D, init[i++]);
      setNumber2D(this, E, init[i++]);
      setNumber2D(this, F, init[i++]);
    }
    else if (init && init.length === 16) {
      setNumber2D(this, M11, init[i++]);
      setNumber2D(this, M12, init[i++]);
      setNumber3D(this, M13, init[i++]);
      setNumber3D(this, M14, init[i++]);
      setNumber2D(this, M21, init[i++]);
      setNumber2D(this, M22, init[i++]);
      setNumber3D(this, M23, init[i++]);
      setNumber3D(this, M24, init[i++]);
      setNumber3D(this, M31, init[i++]);
      setNumber3D(this, M32, init[i++]);
      setNumber3D(this, M33, init[i++]);
      setNumber3D(this, M34, init[i++]);
      setNumber2D(this, M41, init[i++]);
      setNumber2D(this, M42, init[i++]);
      setNumber3D(this, M43, init[i++]);
      setNumber3D(this, M44, init[i]);
    }
    else if (init !== undefined) {
      throw new TypeError("Expected string, array, or matrix object.");
    }
  }

  dump(){
    let mat = this[$values]
    console.log([
      mat.slice(0,4),
      mat.slice(4,8),
      mat.slice(8,12),
      mat.slice(12,16)
    ])
  }

  [inspect.custom](depth, options) {
    if (depth < 0) return "[DOMMatrix]"

    let {a, b, c, d, e, f, is2D, isIdentity} = this
    if (this.is2D){
      return `DOMMatrix ${inspect({a, b, c, d, e, f, is2D, isIdentity}, {colors:true})}`
    }else{
      let {m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44, is2D, isIdentity} = this
      return `DOMMatrix ${inspect({a, b, c, d, e, f, m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44, is2D, isIdentity}, {colors:true})}`
    }
  }

  multiply(other) {
    return newInstance(this[$values]).multiplySelf(other);
  }

  multiplySelf(other) {
    this[$values] = multiply(other[$values], this[$values]);

    if (!other.is2D) {
      this[$is2D] = false;
    }

    return this;
  }

  preMultiplySelf(other) {
    this[$values] = multiply(this[$values], other[$values]);

    if (!other.is2D) {
      this[$is2D] = false;
    }

    return this;
  }

  translate(tx, ty, tz) {
    return newInstance(this[$values]).translateSelf(tx, ty, tz);
  }

  translateSelf(tx = 0, ty = 0, tz = 0) {
    this[$values] = multiply([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      tx, ty, tz, 1
    ], this[$values]);

    if (tz !== 0) {
      this[$is2D] = false;
    }

    return this;
  }

  scale(scaleX, scaleY, scaleZ, originX, originY, originZ) {
    return newInstance(this[$values]).scaleSelf(scaleX, scaleY, scaleZ, originX, originY, originZ);
  }

  scale3d(scale, originX, originY, originZ) {
    return newInstance(this[$values]).scale3dSelf(scale, originX, originY, originZ);
  }

  scale3dSelf(scale, originX, originY, originZ) {
    return this.scaleSelf(scale, scale, scale, originX, originY, originZ);
  }

  scaleSelf(scaleX, scaleY, scaleZ, originX, originY, originZ) {
    // Not redundant with translate's checks because we need to negate the values later.
    if (typeof originX !== "number") originX = 0;
    if (typeof originY !== "number") originY = 0;
    if (typeof originZ !== "number") originZ = 0;

    this.translateSelf(originX, originY, originZ);

    if (typeof scaleX !== "number") scaleX = 1;
    if (typeof scaleY !== "number") scaleY = scaleX;
    if (typeof scaleZ !== "number") scaleZ = 1;

    this[$values] = multiply([
      scaleX, 0, 0, 0,
      0, scaleY, 0, 0,
      0, 0, scaleZ, 0,
      0, 0, 0, 1
    ], this[$values]);

    this.translateSelf(-originX, -originY, -originZ);

    if (scaleZ !== 1 || originZ !== 0) {
      this[$is2D] = false;
    }

    return this;
  }

  rotateFromVector(x, y) {
    return newInstance(this[$values]).rotateFromVectorSelf(x, y);
  }

  rotateFromVectorSelf(x = 0, y = 0) {
    let theta = (x === 0 && y === 0) ? 0 : Math.atan2(y, x) * DEGREE_PER_RAD;
    return this.rotateSelf(theta);
  }

  rotate(rotX, rotY, rotZ) {
    return newInstance(this[$values]).rotateSelf(rotX, rotY, rotZ);
  }

  rotateSelf(rotX, rotY, rotZ) {
    if (rotY === undefined && rotZ === undefined) {
      rotZ = rotX;
      rotX = rotY = 0;
    }

    if (typeof rotY !== "number") rotY = 0;
    if (typeof rotZ !== "number") rotZ = 0;

    if (rotX !== 0 || rotY !== 0) {
      this[$is2D] = false;
    }

    rotX *= RAD_PER_DEGREE;
    rotY *= RAD_PER_DEGREE;
    rotZ *= RAD_PER_DEGREE;

    let c = Math.cos(rotZ);
    let s = Math.sin(rotZ);

    this[$values] = multiply([
      c, s, 0, 0,
      -s, c, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]);

    c = Math.cos(rotY);
    s = Math.sin(rotY);

    this[$values] = multiply([
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      0, 0, 0, 1
    ], this[$values]);

    c = Math.cos(rotX);
    s = Math.sin(rotX);

    this[$values] = multiply([
      1, 0, 0, 0,
      0, c, s, 0,
      0, -s, c, 0,
      0, 0, 0, 1
    ], this[$values]);

    return this;
  }

  rotateAxisAngle(x, y, z, angle) {
    return newInstance(this[$values]).rotateAxisAngleSelf(x, y, z, angle);
  }

  rotateAxisAngleSelf(x = 0, y = 0, z = 0, angle = 0) {
    let length = Math.sqrt(x * x + y * y + z * z);

    if (length === 0) {
      return this;
    }

    if (length !== 1) {
      x /= length;
      y /= length;
      z /= length;
    }

    angle *= RAD_PER_DEGREE;

    let c = Math.cos(angle);
    let s = Math.sin(angle);
    let t = 1 - c;
    let tx = t * x;
    let ty = t * y;

    this[$values] = multiply([
      tx * x + c,      tx * y + s * z,  tx * z - s * y,  0,
      tx * y - s * z,  ty * y + c,      ty * z + s * x,  0,
      tx * z + s * y,  ty * z - s * x,  t * z * z + c,   0,
      0,               0,               0,               1
    ], this[$values]);

    if (x !== 0 || y !== 0) {
      this[$is2D] = false;
    }

    return this;
  }

  skew(sx, sy){
    return newInstance(this[$values]).skewSelf(sx, sy);
  }

  skewSelf(sx, sy){
    if (typeof sx !== "number" && typeof sy !== "number") {
      return this;
    }

    let x = isNaN(sx) ? 0 : Math.tan(sx * RAD_PER_DEGREE);
    let y = isNaN(sy) ? 0 : Math.tan(sy * RAD_PER_DEGREE);

    this[$values] = multiply([
      1, y, 0, 0,
      x, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]);

    return this;
  }

  skewX(sx) {
    return newInstance(this[$values]).skewXSelf(sx);
  }

  skewXSelf(sx) {
    if (typeof sx !== "number") {
      return this;
    }

    let t = Math.tan(sx * RAD_PER_DEGREE);

    this[$values] = multiply([
      1, 0, 0, 0,
      t, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]);

    return this;
  }

  skewY(sy) {
    return newInstance(this[$values]).skewYSelf(sy);
  }

  skewYSelf(sy) {
    if (typeof sy !== "number") {
      return this;
    }

    let t = Math.tan(sy * RAD_PER_DEGREE);

    this[$values] = multiply([
      1, t, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]);

    return this;
  }

  flipX() {
    return newInstance(multiply([
      -1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]));
  }

  flipY() {
    return newInstance(multiply([
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ], this[$values]));
  }

  inverse () {
    return newInstance(this[$values]).invertSelf();
  }

  invertSelf() {
    if (this[$is2D]) {
      let det = this[$values][A] * this[$values][D] - this[$values][B] * this[$values][C];

      // Invertable
      if (det !== 0) {
        let result = new DOMMatrix();

        result.a =  this[$values][D] / det;
        result.b = -this[$values][B] / det;
        result.c = -this[$values][C] / det;
        result.d =  this[$values][A] / det;
        result.e = (this[$values][C] * this[$values][F] - this[$values][D] * this[$values][E]) / det;
        result.f = (this[$values][B] * this[$values][E] - this[$values][A] * this[$values][F]) / det;

        return result;
      }

      // Not invertable
      else {
        this[$is2D] = false;

        this[$values] = [
          NaN, NaN, NaN, NaN,
          NaN, NaN, NaN, NaN,
          NaN, NaN, NaN, NaN,
          NaN, NaN, NaN, NaN
        ];
      }
    }
    else {
      throw new Error("3D matrix inversion is not implemented.");
    }
  }

  setMatrixValue(transformList) {
    let temp = new DOMMatrix(transformList);

    this[$values] = temp[$values];
    this[$is2D] = temp[$is2D];

    return this;
  }

  transformPoint(point) {
    let x = point.x;
    let y = point.y;
    let z = point.z;
    let w = point.w;

    let values = this[$values];

    let nx = values[M11] * x + values[M21] * y + values[M31] * z + values[M41] * w;
    let ny = values[M12] * x + values[M22] * y + values[M32] * z + values[M42] * w;
    let nz = values[M13] * x + values[M23] * y + values[M33] * z + values[M43] * w;
    let nw = values[M14] * x + values[M24] * y + values[M34] * z + values[M44] * w;

    return new DOMPoint(nx, ny, nz, nw);
  }

  toFloat32Array() {
    return Float32Array.from(this[$values]);
  }

  toFloat64Array() {
    return this[$values].slice(0);
  }

  toJSON() {
    return {
      a: this.a,
      b: this.b,
      c: this.c,
      d: this.d,
      e: this.e,
      f: this.f,
      m11: this.m11,
      m12: this.m12,
      m13: this.m13,
      m14: this.m14,
      m21: this.m21,
      m22: this.m22,
      m23: this.m23,
      m24: this.m24,
      m31: this.m31,
      m32: this.m32,
      m33: this.m33,
      m34: this.m34,
      m41: this.m41,
      m42: this.m42,
      m43: this.m43,
      m44: this.m44,
      is2D: this.is2D,
      isIdentity: this.isIdentity
    };
  }

  toString() {
    let name = this.is2D ? 'matrix' : 'matrix3d'
    let values = this.is2D ? [this.a, this.b, this.c, this.d, this.e, this.f] : this[$values]
    let simplify = n => n.toFixed(12).replace(/\.([^0])?0*$/, ".$1").replace(/\.$/, '').replace(/^-0$/, '0')
    return `${name}(${values.map(simplify).join(', ')})`
  }

  clone(){
    return new DOMMatrix(this)
  }
}

for (let propertyName of [
  "a", "b", "c", "d", "e", "f",
  "m11", "m12", "m13", "m14",
  "m21", "m22", "m23", "m24",
  "m31", "m32", "m33", "m34",
  "m41", "m42", "m43", "m44",
  "is2D", "isIdentity"
]) {
  let propertyDescriptor = Object.getOwnPropertyDescriptor(DOMMatrix.prototype, propertyName);
  propertyDescriptor.enumerable = true;
  Object.defineProperty(DOMMatrix.prototype, propertyName, propertyDescriptor);
}

//
// Helpers to reconcile Skia and DOMMatrix’s disagreement about row/col orientation
//

function toSkMatrix() {
  if (arguments.length != 1 && arguments.length < 6){
     throw new TypeError("not enough arguments")
  }
  try {
    const m = new DOMMatrix(...arguments);
    return [m.a, m.c, m.e, m.b, m.d, m.f, m.m14, m.m24, m.m44];
  }catch(e){
    throw new TypeError(`Invalid transform matrix argument(s): `+e);
  }
}

function fromSkMatrix(skMatrix){
  let [a, b, c, d, e, f, p0, p1, p2] = skMatrix
  return new DOMMatrix([
    a, d, 0, p0,
    b, e, 0, p1,
    0, 0, 1, 0,
    c, f, 0, p2
  ])
}

module.exports = {DOMPoint, DOMMatrix, DOMRect, toSkMatrix, fromSkMatrix}


/***/ }),

/***/ 87780:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Windows & event handling
//



const {EventEmitter} = __webpack_require__(82361),
      {RustClass, core, inspect, neon, REPR} = __webpack_require__(7302),
      {Canvas} = __webpack_require__(46155),
      css = __webpack_require__(44103)

const checkSupport = () => {
  if (!neon.App) throw new Error("Skia Canvas was compiled without window support")
}

class App extends RustClass{
  static #locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE
  #events = 'native' // `native` for an OS event loop or `node` to poll for ui-events from node
  #started = false // whether the `eventLoop` property is permanently set
  #launcher // timer set by opening windows to ensure app is launched soon after
  #session // Promise that resolves when the current set of windows are all closed

  #windows = []
  #frames = {}
  #fps = 60

  constructor(){
    super(App)

    // set the callback to use for event dispatch & rendering
    if (neon.App) this.ƒ("register", this.#dispatch.bind(this))

    // track new windows and schedule launch if needed
    Window.events.on('open', win => {
      this.#windows.push(win)
      this.#frames[win.id] = 0
      if (!this.#launcher) this.#launcher = setImmediate( () => this.launch() )
      this.ƒ("openWindow", JSON.stringify(win.state), core(win.canvas.pages[win.state.page-1]))
    })

    // drop closed windows
    Window.events.on('close', win => {
      this.#windows = this.#windows.filter(w => w!==win)
      this.ƒ("closeWindow", win.id)
      win.emit('close')
    })
  }

  get windows(){ return [...this.#windows] }
  get running(){ return this.#started }
  get eventLoop(){ return this.#events }
  set eventLoop(mode){
    if (this.#started) throw new Error("Cannot alter event loop after it has begun")
    if (['native', 'node'].includes(mode) && mode != this.#events){
      this.#events = this.ƒ("setMode", mode)
    }
  }
  get fps(){ return this.#fps }
  set fps(rate){
    checkSupport()
    if (rate >= 1 && rate != this.#fps){
      this.#fps = this.ƒ('setRate', rate)
    }
  }

  launch(){
    checkSupport()
    clearImmediate(this.#launcher)
    this.#started = true

    this.#session ??= this.ƒ('activate').finally(() => {
      this.#session = null
      this.#launcher = null
      this.emit('idle', {type:'idle', target:this})
    })

    return this.#session
  }

  #eachWindow(updates, callback){
    for (const [id, payload] of Object.entries(updates || {})){
      let win = this.#windows.find(win => win.id == id)
      if (win) callback(win, payload)
    }
  }

  #dispatch(isFrame, payload){
    let {geom, state, ui} = JSON.parse(payload)

    // merge autogenerated window locations into newly opened windows
    if (geom) this.#eachWindow(geom, (win, {top, left}) => {
      win.left = win.left || left
      win.top = win.top || top
    })

    // update state of windows that are still active and mark others as closed
    if (state) this.#windows = this.#windows.filter(win => {
      // keep active windows and new ones still waiting for a `geom` roundtrip to set their initial position
      if (win.id in state || win.top === undefined){
        Object.assign(win, state[win.id])
        return true
      }

      // but otherwise evict all windows that have been closed via title bar widget
      win.close()
    })

    // deliver ui events to corresponding windows
    if (ui) this.#eachWindow(ui, (win, events) => {
      for (const [[type, e]] of events.map(o => Object.entries(o))){
        switch(type){
          case 'mouse':
            var {button, buttons, point, page_point:{x:pageX, y:pageY}, modifiers} = e
            win.emit(e.event, {button, buttons, ...point, pageX, pageY, ...modifiers})
          break

          case 'input':
            let [data, inputType] = e
            win.emit(type, {data, inputType})
          break

          case 'composition':
            win.emit(e.event, {data:e.data, locale:App.#locale})
          break

          case 'keyboard':
            var {event, key, code, location, repeat, modifiers} = e,
                defaults = true;

            win.emit(event, {key, code, location, repeat, ...modifiers,
              preventDefault:() => defaults = false
            })

            // apply default keybindings unless e.preventDefault() was run
            if (defaults && event=='keydown' && !repeat){
              let {ctrlKey, altKey, metaKey} = modifiers
              if ( (metaKey && key=='w') || (ctrlKey && key=='c') || (altKey && key=='F4') ){
                win.close()
              }else if ( (metaKey && key=='f') || (altKey && key=='F8') ){
                win.fullscreen = !win.fullscreen
              }
            }
          break

          case 'focus':
            if (e) win.emit('focus')
            else win.emit('blur')
          break

          case 'resize':
            if (win.fit == 'resize'){
              win.ctx.prop('size', e.width, e.height)
              win.canvas.prop('width', e.width)
              win.canvas.prop('height', e.height)
            }
            win.emit(type, e)
          break

          case 'move':
          case 'wheel':
            win.emit(type, e)
          break

          case 'fullscreen':
            win.emit(type, {enabled: e})
          break

          default:
            console.log(type, e);
        }
      }
    })

    // provide frame updates to prompt redraws
    if (isFrame) for (let win of this.#windows){
      let frame = ++this.#frames[win.id]

      if (frame==0) win.emit("setup")
      win.emit("frame", {frame})
      if (win.listenerCount('draw')){
        win.canvas.getContext("2d").reset()
        win.emit("draw", {frame})
      }
    }

    // if this is a full roundtrip, return window state & content
    return isFrame && [
      JSON.stringify( this.#windows.map(win => win.state) ),
      this.#windows.map(win => core(win.canvas.pages[win.page-1]) )
    ]
  }

  quit(){
    this.ƒ("quit")
  }

  [REPR](depth, options) {
    let {eventLoop, fps, windows} = this
    return `App ${inspect({eventLoop, fps, windows}, Object.assign(options, {
      depth:1, customInspect:false
    }))}`
  }
}

// Mix the EventEmitter properties into App
Object.assign(App.prototype, EventEmitter.prototype)

class Window extends EventEmitter{
  static events = new EventEmitter()
  static #kwargs = "id,left,top,width,height,title,page,background,fullscreen,cursor,fit,visible,resizable,borderless,closed".split(/,/)
  static #nextID = 1
  #canvas
  #state

  // accept either ƒ(width, height, {…}) or ƒ({…})
  constructor(width=512, height=512, opts={}){
    checkSupport()

    if (!Number.isFinite(width) || !Number.isFinite(height)){
      opts = [...arguments].slice(-1)[0] || {}
      width = opts.width || (opts.canvas || {}).width || 512
      height = opts.height || (opts.canvas || {}).height || 512
    }

    let hasCanvas = opts.canvas instanceof Canvas
    let {textContrast=0, textGamma=1.4} = hasCanvas ? opts.canvas.engine : opts
    let canvas = hasCanvas ? opts.canvas : new Canvas(width, height, {textContrast, textGamma})

    super(Window)
    this.#state = {
      title: "",
      visible: true,
      resizable: true,
      borderless: false,
      background: "white",
      fullscreen: false,
      closed: false,
      page: canvas.pages.length,
      left: undefined,
      top: undefined,
      width,
      height,
      textContrast,
      textGamma,
      cursor: "default",
      fit: "contain",
      id: Window.#nextID++
    }

    Object.assign(this, {canvas}, Object.fromEntries(
      Object.entries(opts).filter(([k, v]) => Window.#kwargs.includes(k) && v!==undefined)
    ))

    Window.events.emit('open', this)
  }

  get state(){ return {...this.#state} }
  get ctx(){ return this.#canvas.pages[this.page-1] }

  get id(){ return this.#state.id }
  set id(id){ if (id!=this.id) throw new Error("Window IDs are immutable") }

  get canvas(){ return this.#canvas }
  set canvas(canvas){
    if (canvas instanceof Canvas){
      canvas.getContext("2d") // ensure it has at least one page
      this.#canvas = canvas
      this.#state.page = canvas.pages.length
      this.#state.textContrast = canvas.engine.textContrast
      this.#state.textGamma = canvas.engine.textGamma
    }
  }

  get visible(){ return this.#state.visible }
  set visible(flag){ this.#state.visible = !!flag }

  get resizable(){ return this.#state.resizable }
  set resizable(flag){ this.#state.resizable = !!flag }

  get borderless(){ return this.#state.borderless }
  set borderless(flag){ this.#state.borderless = !!flag }

  get fullscreen(){ return this.#state.fullscreen }
  set fullscreen(flag){ this.#state.fullscreen = !!flag }

  get title(){ return this.#state.title }
  set title(txt){ this.#state.title = (txt != null ? txt : '').toString() }

  get cursor(){ return this.#state.cursor }
  set cursor(icon){
    if (css.cursor(icon)){
      this.#state.cursor = icon
    }
  }

  get fit(){ return this.#state.fit }
  set fit(mode){ if (css.fit(mode)) this.#state.fit = mode }

  get left(){ return this.#state.left }
  set left(val){ if (Number.isFinite(val)) this.#state.left = val }

  get top(){ return this.#state.top }
  set top(val){ if (Number.isFinite(val)) this.#state.top = val }

  get width(){ return this.#state.width }
  set width(val){ if (Number.isFinite(val)) this.#state.width = val }

  get height(){ return this.#state.height }
  set height(val){ if (Number.isFinite(val)) this.#state.height = val }

  get page(){ return this.#state.page }
  set page(val){
    if (val < 0) val += this.#canvas.pages.length + 1
    let page = this.#canvas.pages[val-1]
    if (page && this.#state.page != val){
      let [width, height] = page.prop('size')
      this.#canvas.prop('width', width)
      this.#canvas.prop('height', height)
      this.#state.page = val
    }
  }

  get background(){ return this.#state.background }
  set background(c){ this.#state.background = (c != null ? c : '').toString() }

  get closed(){ return this.#state.closed }
  close(){
    if (!this.#state.closed){
      this.#state.closed = true
      Window.events.emit('close', this)
    }
  }
  open(){
    if (this.#state.closed){
      this.#state.closed = false
      Window.events.emit('open', this)
    }
  }

  emit(type, e){
    // report errors in event-handlers but don't crash
    try{ super.emit(type, Object.assign({target:this, type}, e)) }
    catch(err){ console.error(err) }
  }

  [REPR](depth, options) {
    let info = Object.fromEntries(Window.#kwargs.map(k => [k, this.#state[k]]))
    return `Window ${inspect(info, options)}`
  }
}

module.exports = {App:new App(), Window}


/***/ }),

/***/ 39266:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Image & ImageData
//



const {RustClass, core, readOnly, inspect, neon, argc, REPR} = __webpack_require__(7302),
      {fetchURL, decodeDataURL, expandURL} = __webpack_require__(90174),
      {EventEmitter} = __webpack_require__(82361),
      {readFile} = __webpack_require__(73292)

//
// Image
//

const DecodingError = () => new Error("Could not decode image data")

const loadImage = (src, options) => new Promise((res, rej) =>
  fetchData(src, options,
    (data, src, raw) => {
      let img = new Image()
      img.prop('src', src)
      if (img.prop('data', data, raw)) res(img)
      else rej(DecodingError())
    },
    rej,
  )
)

class Image extends RustClass {
  #fetch
  #err

  constructor(data, src='') {
    super(Image).alloc()

    data = expandURL(data)
    this.prop("src", ''+src || '::Buffer::')

    if (Buffer.isBuffer(data)) {
      if (!this.prop("data", data)) throw DecodingError()
    }else if (typeof data=='string'){
      decodeDataURL(data,
        buffer => {
          if (!this.prop("data", buffer)) throw DecodingError()
          if (!src) this.prop("src", data)
        },
        err => { throw err },
      )
    }else if (data){
      throw TypeError(`Exptected a Buffer or a String containing a data URL (got: ${data})`)
    }
  }

  get complete(){ return this.prop('complete') }
  get height(){ return this.prop('height') }
  get width(){ return this.prop('width') }

  #onload
  get onload(){ return this.#onload }
  set onload(cb){
    if (this.#onload) this.off('load', this.#onload)
    this.#onload = typeof cb=='function' ? cb : null
    if (this.#onload) this.on('load', this.#onload)
  }

  #onerror
  get onerror(){ return this.#onerror }
  set onerror(cb){
    if (this.#onerror) this.off('error', this.#onerror)
    this.#onerror = typeof cb=='function' ? cb : null
    if (this.#onerror) this.on('error', this.#onerror)
  }

  get src(){ return this.prop('src') }
  set src(src){
    const request = this.#fetch = {} // use an empty object as a unique token
    const loaded = (data, imgSrc, raw) => {
      if (request === this.#fetch){ // confirm this is the most recent request with ===
        this.#fetch = undefined
        this.prop("src", imgSrc)
        this.#err = this.prop("data", data, raw) ? null : DecodingError()
        if (this.#err) this.emit('error', this.#err)
        else this.emit('load', this)
      }
    }
    const failed = (err) => {
      if (request === this.#fetch){ // confirm this is the most recent request with ===
        this.#fetch = undefined
        this.#err = err
        this.prop("data", Buffer.alloc(0))
        this.emit('error', err)
      }
    }

    src = expandURL(src)
    this.prop("src", typeof src=='string' ? src : '')

    fetchData(src, undefined, loaded, failed)
  }

  decode(){
    return this.#fetch ? new Promise((res, rej) => this.once('load', res).once('error', rej) )
         : this.#err ? Promise.reject(this.#err)
         : this.complete ? Promise.resolve(this)
         : Promise.reject(new Error("Image source not set"))
  }

  [REPR](depth, options) {
    let {width, height, complete, src} = this
    options.maxStringLength = src.match(/^data:/) ? 128 : Infinity;
    return `Image ${inspect({width, height, complete, src}, options)}`
  }
}

// Mix the EventEmitter properties into Image
Object.assign(Image.prototype, EventEmitter.prototype)

//
// ImageData
//

const loadImageData = (src, ...args) => new Promise((res, rej) => {
  let {colorType, colorSpace, ...options} = args[2] || {}
  fetchData(src, options, (data, src, raw) => res(
    raw ? new ImageData(data, raw.width, raw.height) : new ImageData(data, ...args)
  ), rej)
})

class ImageData{
  constructor(...args){
    if (args[0] instanceof ImageData){
      argc(arguments, 1)
      var {data, width, height, colorSpace, colorType, bytesPerPixel} = args[0]
    }else if (args[0] instanceof Image){
      argc(arguments, 1)
      var [image, {colorSpace='srgb', colorType='rgba'}={}] = args,
          {width, height} = image,
          bytesPerPixel = pixelSize(colorType),
          buffer = neon.Image.pixels(core(image), {colorType}),
          data = new Uint8ClampedArray(buffer)
    }else if (args[0] instanceof Uint8ClampedArray || args[0] instanceof Buffer){
      argc(arguments, 2)
      var [data, width, height, {colorSpace='srgb', colorType='rgba'}={}] = args,
          bytesPerPixel = pixelSize(colorType) // validates the string as side effect

      width = Math.floor(Math.abs(width))
      height = Math.floor(Math.abs(height || data.length / width / bytesPerPixel))
      data = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data)
      if (data.length / bytesPerPixel != width * height){
        throw new TypeError("ImageData dimensions must match buffer length")
      }
    }else{
      argc(arguments, 2)
      var [width, height, {colorSpace='srgb', colorType='rgba'}={}] = args,
          bytesPerPixel = pixelSize(colorType)

      width = Math.floor(Math.abs(width))
      height = Math.floor(Math.abs(height))
    }

    if (!['srgb'].includes(colorSpace)){ // TODO: add display-p3 when supported…
      throw TypeError(`Unsupported colorSpace: ${colorSpace}`)
    }

    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0){
      throw RangeError("Dimensions must be non-zero")
    }

    readOnly(this, "colorSpace", colorSpace)
    readOnly(this, "colorType", colorType)
    readOnly(this, "width", width)
    readOnly(this, "height", height)
    readOnly(this, 'bytesPerPixel', bytesPerPixel)
    readOnly(this, "data", data || new Uint8ClampedArray(width * height * bytesPerPixel))
  }

  toSharp(){
    const sharp = getSharp()
    let {width, height, bytesPerPixel:channels} = this
    return sharp(this.data, {raw:{width, height, channels}}).withMetadata({density:72})
  }

  [REPR](depth, options) {
    let {width, height, colorType, bytesPerPixel, data} = this
    return `ImageData ${inspect({width, height, colorType, bytesPerPixel, data}, options)}`
  }
}

//
// Utilities
//

function pixelSize(colorType){
  const bpp = ["Alpha8", "Gray8", "R8UNorm"].includes(colorType) ? 1
    : ["A16Float", "A16UNorm", "ARGB4444", "R8G8UNorm", "RGB565"].includes(colorType) ? 2
    : [ "rgb", "rgba", "bgra", "BGR101010x", "BGRA1010102", "BGRA8888", "R16G16Float", "R16G16UNorm",
        "RGB101010x", "RGB888x", "RGBA1010102", "RGBA8888", "RGBA8888", "SRGBA8888" ].includes(colorType) ? 4
    : ["R16G16B16A16UNorm", "RGBAF16", "RGBAF16Norm"].includes(colorType) ? 8
    : colorType=="RGBAF32" ? 16
    : 0

  if (!bpp) throw new TypeError(`Unknown colorType: ${colorType}`)
  return bpp
}

function getSharp(){
  try{
    return __webpack_require__(17410)
  }catch(e){
    throw Error("Cannot find module 'sharp' (try running `npm install sharp` first)")
  }
}

function isSharpImage(obj){
   try{
    return obj instanceof __webpack_require__(17410)
  }catch{
    return false
  }
}

const fetchData = (src, reqOpts, loaded, failed) => {
  src = expandURL(src)
  if (Buffer.isBuffer(src)) {
    loaded(src, '::Buffer::')
  }else if (isSharpImage(src)){
    src.ensureAlpha().raw().toBuffer((err, buf, info) => {
      let {options:{input:{file, buffer}}} = src
      if (err) failed(err)
      else loaded(buf, buffer ? '::Sharp::' : file, info)
    })
  }else{
    src = typeof src=='string' ? src : ''+src
    if (src.startsWith('data:')){
      decodeDataURL(src,
        buffer => loaded(buffer, src),
        err =>  failed(err),
      )
    }else if (/^\s*https?:\/\//.test(src)){
      fetchURL(src, reqOpts,
        buffer => loaded(buffer, src),
        err => failed(err)
      )
    }else{
      readFile(src)
        .then(data => loaded(data, src))
        .catch(e => failed(e))
    }
  }
}

module.exports = {Image, ImageData, loadImage, loadImageData, pixelSize, getSharp}


/***/ }),

/***/ 7302:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Neon <-> Node interface
//



const {inspect} = __webpack_require__(73837)

// if defined, throw TypeErrors for canvas API calls with invalid arguments
const STRICT = !["0", "false", "off"].includes((process.env.SKIA_CANVAS_STRICT || "0").trim().toLowerCase())

const ø = Symbol.for('📦'), // the attr containing the boxed struct
      core = (obj) => (obj||{})[ø], // dereference the boxed struct
      wrap = (type, struct) => { // create new instance for struct
        let obj = internal(Object.create(type.prototype), ø, struct)
        return struct && internal(obj, 'native', neon[type.name])
      },
      neon = Object.entries(__webpack_require__(62109)).reduce( (api, [name, fn]) => {
        let [_, struct, getset, attr] = name.match(/(.*?)_(?:([sg]et)_)?(.*)/),
            cls = api[struct] || (api[struct] = {}),
            slot = getset ? (cls[attr] || (cls[attr] = {})) : cls
        slot[getset || attr] = fn
        return api
      }, {})

class RustClass{
  constructor(type){
    internal(this, 'native', neon[type.name])
  }

  alloc(...args){
    try{
      return this.init('new', ...args)
    }catch(error){
      rustError(error, this.alloc)
    }
  }

  init(fn, ...args){
    try{
      return internal(this, ø, this.native[fn](null, ...args))
    }catch(error){
      rustError(error, this.init)
    }
  }

  ref(key, val){
    return arguments.length > 1 ? this[Symbol.for(key)] = val : this[Symbol.for(key)]
  }

  prop(attr, ...vals){
    try{
      let getset = arguments.length > 1 ? 'set' : 'get'
      return this.native[attr][getset](this[ø], ...vals)
    }catch(error){
      rustError(error, this.prop)
    }
  }

  ƒ(fn, ...args){
    try{
      return this.native[fn](this[ø], ...args)
    }catch(error){
      rustError(error, this.ƒ)
    }
  }
}

// shorthands for attaching read-only attributes
const readOnly = (obj, attr, value) => (
  Object.defineProperty(obj, attr, {value, writable:false, enumerable:true})
)

const internal = (obj, attr, value) => (
  Object.defineProperty(obj, attr, {value, writable:false, enumerable:false})
)

// convert arguments list to a string of type abbreviations
function signature(args){
  return args.map(v => (Array.isArray(v) ? 'a' : {string:'s', number:'n', object:'o'}[typeof v] || 'x')).join('')
}

// validate number of args in invocation
const argc = (args, ...expected) => {
  if (expected.includes(args.length) || args.length > Math.max(...expected)) return
  let error = new TypeError("not enough arguments")
  Error.captureStackTrace(error, argc)
  throw error
}

// remove internals from stack trace and filter non-strict errors
const rustError = (error, stack) => {
  if (error.message.startsWith("⚠️")){
    if (STRICT) error.message = error.message.substr(1)
    else return
  }
  Error.captureStackTrace(error, stack)
  throw error
}

module.exports = {neon, core, wrap, signature, argc, readOnly, RustClass, inspect, REPR:inspect.custom}


/***/ }),

/***/ 24767:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Bézier paths
//



const {RustClass, core, wrap, inspect, argc, REPR} = __webpack_require__(7302),
      {toSkMatrix} = __webpack_require__(86515),
      css = __webpack_require__(44103)

class Path2D extends RustClass{
  static op(operation, path, other){
    let args = other ? [core(other), operation] : []
    return wrap(Path2D, path.ƒ("op", ...args))
  }

  static interpolate(path, other, weight){
    let args = other ? [core(other), weight] : []
    return wrap(Path2D, path.ƒ("interpolate", ...args))
  }

  static effect(effect, path, ...args){
    return wrap(Path2D, path.ƒ(effect, ...args))
  }

  constructor(source){
    super(Path2D)
    if (source instanceof Path2D) this.init('from_path', core(source))
    else if (typeof source == 'string') this.init('from_svg', source)
    else this.alloc()
  }

  // dimensions & contents
  get bounds(){ return this.ƒ('bounds') }
  get edges(){ return this.ƒ("edges") }
  get d(){ return this.prop("d") }
  set d(svg){ return this.prop("d", svg) }
  contains(x, y){ return this.ƒ("contains", ...arguments)}

  points(step=1){
    return this.jitter(step, 0).edges
               .map(([verb, ...pts]) => pts.slice(-2))
               .filter(pt => pt.length)
  }

  // concatenation
  addPath(path, matrix){
    let args = path instanceof Path2D ? [core(path)] : []
    if (matrix) args.push(toSkMatrix(matrix))
    this.ƒ('addPath', ...args)
  }

  // line segments
  moveTo(x, y){ this.ƒ("moveTo", ...arguments) }
  lineTo(x, y){ this.ƒ("lineTo", ...arguments) }
  closePath(){ this.ƒ("closePath") }
  arcTo(x1, y1, x2, y2, radius){ this.ƒ("arcTo", ...arguments) }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this.ƒ("bezierCurveTo", ...arguments) }
  quadraticCurveTo(cpx, cpy, x, y){ this.ƒ("quadraticCurveTo", ...arguments) }
  conicCurveTo(cpx, cpy, x, y, weight){ this.ƒ("conicCurveTo", ...arguments) }

  // shape primitives
  ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, isCCW){ this.ƒ("ellipse", ...arguments) }
  rect(x, y, width, height){this.ƒ("rect", ...arguments) }
  arc(x, y, radius, startAngle, endAngle){ this.ƒ("arc", ...arguments) }
  roundRect(x, y, w, h, r){
    argc(arguments, 4, 5)
    let radii = css.radii(r)
    if (radii){
      if (w < 0) radii = [radii[1], radii[0], radii[3], radii[2]]
      if (h < 0) radii = [radii[3], radii[2], radii[1], radii[0]]
      this.ƒ("roundRect", x, y, w, h, ...radii.map(({x, y}) => [x, y]).flat())
    }
  }

  // tween similar paths
  interpolate(path, weight){ return Path2D.interpolate(this, ...arguments) }

  // boolean operations
  complement(path){ return Path2D.op("complement", this, ...arguments) }
  difference(path){ return Path2D.op("difference", this, ...arguments) }
  intersect(path){  return Path2D.op("intersect", this, ...arguments) }
  union(path){      return Path2D.op("union", this, ...arguments) }
  xor(path){        return Path2D.op("xor", this, ...arguments) }

  // path effects
  jitter(len, amt, seed){ return Path2D.effect("jitter", this, ...arguments) }
  simplify(rule){         return Path2D.effect("simplify", this, ...arguments) }
  unwind(){               return Path2D.effect("unwind", this) }
  round(radius){          return Path2D.effect("round", this, ...arguments) }
  offset(dx, dy){         return Path2D.effect("offset", this, ...arguments) }

  transform(matrix){
    return Path2D.effect("transform", this, toSkMatrix.apply(null, arguments))
  }

  trim(...rng){
    if (typeof rng[1] != 'number'){
      if (rng[0] > 0) rng.unshift(0)
      else if (rng[0] < 0) rng.splice(1, 0, 1)
    }
    if (rng[0] < 0) rng[0] = Math.max(-1, rng[0]) + 1
    if (rng[1] < 0) rng[1] = Math.max(-1, rng[1]) + 1
    return Path2D.effect("trim", this, ...rng)
  }

  [REPR](depth, options) {
    let {d, bounds, edges} = this
    return `Path2D ${inspect({d, bounds, edges}, options)}`
  }
}

module.exports = {Path2D}


/***/ }),

/***/ 10040:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Font management & metrics
//



const {RustClass, readOnly, signature, inspect, REPR} = __webpack_require__(7302)

class FontLibrary extends RustClass {
  constructor(){
    super(FontLibrary)
  }

  get families(){ return this.prop('families') }

  has(familyName){ return this.ƒ('has', familyName) }

  family(name){ return this.ƒ('family', name) }

  use(...args){
    let sig = signature(args)
    if (sig=='o'){
      let results = {}
      for (let [alias, paths] of Object.entries(args.shift())){
        results[alias] = this.ƒ("addFamily", alias, [paths].flat())
      }
      return results
    }else if (sig.match(/^s?[as]$/)){
      let fonts = [args.pop()].flat()
      let alias = args.shift()
      return this.ƒ("addFamily", alias, fonts)
    }else{
      throw new Error("Expected an array of file paths or an object mapping family names to font files")
    }
  }

  reset(){ return this.ƒ('reset') }
}

class TextMetrics{
  constructor(metrics){
    for (let k in metrics) readOnly(this, k, metrics[k])
  }
}


module.exports = {FontLibrary:new FontLibrary(), TextMetrics}


/***/ }),

/***/ 18041:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

//
// Skia Canvas — CommonJS version
//



const {Canvas, CanvasGradient, CanvasPattern, CanvasTexture} = __webpack_require__(46155),
      {Image, ImageData, loadImage, loadImageData} = __webpack_require__(39266),
      {DOMPoint, DOMMatrix, DOMRect} = __webpack_require__(86515),
      {TextMetrics, FontLibrary} = __webpack_require__(10040),
      {CanvasRenderingContext2D} = __webpack_require__(7949),
      {App, Window} = __webpack_require__(87780),
      {Path2D} = __webpack_require__(24767)

module.exports = {
  Canvas, CanvasGradient, CanvasPattern, CanvasTexture,
  Image, ImageData, loadImage, loadImageData,
  Path2D, DOMPoint, DOMMatrix, DOMRect,
  FontLibrary, TextMetrics,
  CanvasRenderingContext2D,
  App, Window,
}


/***/ }),

/***/ 90174:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

const url = __webpack_require__(57310),
      {http, https} = __webpack_require__(67707),
      {HttpsProxyAgent} = __webpack_require__(69854)

const UA = {"User-Agent": "Skia Canvas"}
const PROXY_URL =
  process.env.https_proxy || process.env.HTTPS_PROXY ||
  process.env.http_proxy || process.env.HTTP_PROXY

const fetchURL = (url, opts, ok, fail) => {
  let proto = url.slice(0,5).split(':')[0],
      client = {http, https}[proto.toLowerCase()]

  if (!client){
    fail(new Error(`Unsupported protocol: expected 'http' or 'https' (got: ${proto})`))
  }else{
    opts = opts || {}
    opts.headers = {...UA, ...opts.headers}
    opts.agent = opts.agent===undefined && PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : opts.agent

    let req = client.request(url, opts, resp => {
      if (resp.statusCode < 200 || resp.statusCode >= 300){
        fail(new Error(`Failed to load image from "${url}" (HTTP error ${resp.statusCode})`))
      }else{
        const chunks = []
        resp.on("data", chunk => chunks.push(chunk))
        resp.on("end", () => ok(Buffer.concat(chunks)))
        resp.on('error', e => fail(e))
      }
    })

    req.on('error', e => fail(e))
    if (opts.body) req.write(opts.body)
    req.end()
  }
}

const decodeDataURL = (dataURL, ok, fail) => {
  if (typeof dataURL!='string') return fail(TypeError(`Expected a data URL string (got ${typeof dataURL})`))
  let [header, mime, enc] = dataURL.slice(0, 40).match(/^\s*data:(?<mime>[^;]*);(?:charset=)?(?<enc>[^,]*),/) || []
  if (!mime || !enc) return fail(TypeError(`Expected a valid data URL string (got: "${dataURL}")`))

  // SVGs in particular may not be base64 encoded
  let content = dataURL.slice(header.length)
  if (enc.toLowerCase() != 'base64') content = decodeURIComponent(content)

  try{ ok(Buffer.from(content, enc)) }
  catch(e){ fail(e) }
}

const expandURL = (src) => {
  // convert URLs to strings, otherwise pass arg through unmodified
  if (src instanceof URL){
    if (src.protocol=='file:') src = url.fileURLToPath(src)
    else if (src.protocol.match(/^(https?|data):/)) src = src.href
    else throw Error(`Unsupported protocol: ${src.protocol.replace(':', '')}`)
  }
  return src
}

module.exports = {fetchURL, decodeDataURL, expandURL}


/***/ }),

/***/ 67393:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.req = exports.json = exports.toBuffer = void 0;
const http = __importStar(__webpack_require__(13685));
const https = __importStar(__webpack_require__(95687));
async function toBuffer(stream) {
    let length = 0;
    const chunks = [];
    for await (const chunk of stream) {
        length += chunk.length;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
}
exports.toBuffer = toBuffer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(stream) {
    const buf = await toBuffer(stream);
    const str = buf.toString('utf8');
    try {
        return JSON.parse(str);
    }
    catch (_err) {
        const err = _err;
        err.message += ` (input: ${str})`;
        throw err;
    }
}
exports.json = json;
function req(url, opts = {}) {
    const href = typeof url === 'string' ? url : url.href;
    const req = (href.startsWith('https:') ? https : http).request(url, opts);
    const promise = new Promise((resolve, reject) => {
        req
            .once('response', resolve)
            .once('error', reject)
            .end();
    });
    req.then = promise.then.bind(promise);
    return req;
}
exports.req = req;
//# sourceMappingURL=helpers.js.map

/***/ }),

/***/ 81059:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Agent = void 0;
const net = __importStar(__webpack_require__(41808));
const http = __importStar(__webpack_require__(13685));
const https_1 = __webpack_require__(95687);
__exportStar(__webpack_require__(67393), exports);
const INTERNAL = Symbol('AgentBaseInternalState');
class Agent extends http.Agent {
    constructor(opts) {
        super(opts);
        this[INTERNAL] = {};
    }
    /**
     * Determine whether this is an `http` or `https` request.
     */
    isSecureEndpoint(options) {
        if (options) {
            // First check the `secureEndpoint` property explicitly, since this
            // means that a parent `Agent` is "passing through" to this instance.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (typeof options.secureEndpoint === 'boolean') {
                return options.secureEndpoint;
            }
            // If no explicit `secure` endpoint, check if `protocol` property is
            // set. This will usually be the case since using a full string URL
            // or `URL` instance should be the most common usage.
            if (typeof options.protocol === 'string') {
                return options.protocol === 'https:';
            }
        }
        // Finally, if no `protocol` property was set, then fall back to
        // checking the stack trace of the current call stack, and try to
        // detect the "https" module.
        const { stack } = new Error();
        if (typeof stack !== 'string')
            return false;
        return stack
            .split('\n')
            .some((l) => l.indexOf('(https.js:') !== -1 ||
            l.indexOf('node:https:') !== -1);
    }
    // In order to support async signatures in `connect()` and Node's native
    // connection pooling in `http.Agent`, the array of sockets for each origin
    // has to be updated synchronously. This is so the length of the array is
    // accurate when `addRequest()` is next called. We achieve this by creating a
    // fake socket and adding it to `sockets[origin]` and incrementing
    // `totalSocketCount`.
    incrementSockets(name) {
        // If `maxSockets` and `maxTotalSockets` are both Infinity then there is no
        // need to create a fake socket because Node.js native connection pooling
        // will never be invoked.
        if (this.maxSockets === Infinity && this.maxTotalSockets === Infinity) {
            return null;
        }
        // All instances of `sockets` are expected TypeScript errors. The
        // alternative is to add it as a private property of this class but that
        // will break TypeScript subclassing.
        if (!this.sockets[name]) {
            // @ts-expect-error `sockets` is readonly in `@types/node`
            this.sockets[name] = [];
        }
        const fakeSocket = new net.Socket({ writable: false });
        this.sockets[name].push(fakeSocket);
        // @ts-expect-error `totalSocketCount` isn't defined in `@types/node`
        this.totalSocketCount++;
        return fakeSocket;
    }
    decrementSockets(name, socket) {
        if (!this.sockets[name] || socket === null) {
            return;
        }
        const sockets = this.sockets[name];
        const index = sockets.indexOf(socket);
        if (index !== -1) {
            sockets.splice(index, 1);
            // @ts-expect-error  `totalSocketCount` isn't defined in `@types/node`
            this.totalSocketCount--;
            if (sockets.length === 0) {
                // @ts-expect-error `sockets` is readonly in `@types/node`
                delete this.sockets[name];
            }
        }
    }
    // In order to properly update the socket pool, we need to call `getName()` on
    // the core `https.Agent` if it is a secureEndpoint.
    getName(options) {
        const secureEndpoint = this.isSecureEndpoint(options);
        if (secureEndpoint) {
            // @ts-expect-error `getName()` isn't defined in `@types/node`
            return https_1.Agent.prototype.getName.call(this, options);
        }
        // @ts-expect-error `getName()` isn't defined in `@types/node`
        return super.getName(options);
    }
    createSocket(req, options, cb) {
        const connectOpts = {
            ...options,
            secureEndpoint: this.isSecureEndpoint(options),
        };
        const name = this.getName(connectOpts);
        const fakeSocket = this.incrementSockets(name);
        Promise.resolve()
            .then(() => this.connect(req, connectOpts))
            .then((socket) => {
            this.decrementSockets(name, fakeSocket);
            if (socket instanceof http.Agent) {
                try {
                    // @ts-expect-error `addRequest()` isn't defined in `@types/node`
                    return socket.addRequest(req, connectOpts);
                }
                catch (err) {
                    return cb(err);
                }
            }
            this[INTERNAL].currentSocket = socket;
            // @ts-expect-error `createSocket()` isn't defined in `@types/node`
            super.createSocket(req, options, cb);
        }, (err) => {
            this.decrementSockets(name, fakeSocket);
            cb(err);
        });
    }
    createConnection() {
        const socket = this[INTERNAL].currentSocket;
        this[INTERNAL].currentSocket = undefined;
        if (!socket) {
            throw new Error('No socket was returned in the `connect()` function');
        }
        return socket;
    }
    get defaultPort() {
        return (this[INTERNAL].defaultPort ??
            (this.protocol === 'https:' ? 443 : 80));
    }
    set defaultPort(v) {
        if (this[INTERNAL]) {
            this[INTERNAL].defaultPort = v;
        }
    }
    get protocol() {
        return (this[INTERNAL].protocol ??
            (this.isSecureEndpoint() ? 'https:' : 'http:'));
    }
    set protocol(v) {
        if (this[INTERNAL]) {
            this[INTERNAL].protocol = v;
        }
    }
}
exports.Agent = Agent;
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 69854:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.HttpsProxyAgent = void 0;
const net = __importStar(__webpack_require__(41808));
const tls = __importStar(__webpack_require__(24404));
const assert_1 = __importDefault(__webpack_require__(39491));
const debug_1 = __importDefault(__webpack_require__(38237));
const agent_base_1 = __webpack_require__(81059);
const url_1 = __webpack_require__(57310);
const parse_proxy_response_1 = __webpack_require__(86673);
const debug = (0, debug_1.default)('https-proxy-agent');
const setServernameFromNonIpHost = (options) => {
    if (options.servername === undefined &&
        options.host &&
        !net.isIP(options.host)) {
        return {
            ...options,
            servername: options.host,
        };
    }
    return options;
};
/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to
 * the specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * Outgoing HTTP requests are first tunneled through the proxy server using the
 * `CONNECT` HTTP request method to establish a connection to the proxy server,
 * and then the proxy server connects to the destination target and issues the
 * HTTP request from the proxy server.
 *
 * `https:` requests have their socket connection upgraded to TLS once
 * the connection to the proxy server has been established.
 */
class HttpsProxyAgent extends agent_base_1.Agent {
    constructor(proxy, opts) {
        super(opts);
        this.options = { path: undefined };
        this.proxy = typeof proxy === 'string' ? new url_1.URL(proxy) : proxy;
        this.proxyHeaders = opts?.headers ?? {};
        debug('Creating new HttpsProxyAgent instance: %o', this.proxy.href);
        // Trim off the brackets from IPv6 addresses
        const host = (this.proxy.hostname || this.proxy.host).replace(/^\[|\]$/g, '');
        const port = this.proxy.port
            ? parseInt(this.proxy.port, 10)
            : this.proxy.protocol === 'https:'
                ? 443
                : 80;
        this.connectOpts = {
            // Attempt to negotiate http/1.1 for proxy servers that support http/2
            ALPNProtocols: ['http/1.1'],
            ...(opts ? omit(opts, 'headers') : null),
            host,
            port,
        };
    }
    /**
     * Called when the node-core HTTP client library is creating a
     * new HTTP request.
     */
    async connect(req, opts) {
        const { proxy } = this;
        if (!opts.host) {
            throw new TypeError('No "host" provided');
        }
        // Create a socket connection to the proxy server.
        let socket;
        if (proxy.protocol === 'https:') {
            debug('Creating `tls.Socket`: %o', this.connectOpts);
            socket = tls.connect(setServernameFromNonIpHost(this.connectOpts));
        }
        else {
            debug('Creating `net.Socket`: %o', this.connectOpts);
            socket = net.connect(this.connectOpts);
        }
        const headers = typeof this.proxyHeaders === 'function'
            ? this.proxyHeaders()
            : { ...this.proxyHeaders };
        const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
        let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;
        // Inject the `Proxy-Authorization` header if necessary.
        if (proxy.username || proxy.password) {
            const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
            headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
        }
        headers.Host = `${host}:${opts.port}`;
        if (!headers['Proxy-Connection']) {
            headers['Proxy-Connection'] = this.keepAlive
                ? 'Keep-Alive'
                : 'close';
        }
        for (const name of Object.keys(headers)) {
            payload += `${name}: ${headers[name]}\r\n`;
        }
        const proxyResponsePromise = (0, parse_proxy_response_1.parseProxyResponse)(socket);
        socket.write(`${payload}\r\n`);
        const { connect, buffered } = await proxyResponsePromise;
        req.emit('proxyConnect', connect);
        this.emit('proxyConnect', connect, req);
        if (connect.statusCode === 200) {
            req.once('socket', resume);
            if (opts.secureEndpoint) {
                // The proxy is connecting to a TLS server, so upgrade
                // this socket connection to a TLS connection.
                debug('Upgrading socket connection to TLS');
                return tls.connect({
                    ...omit(setServernameFromNonIpHost(opts), 'host', 'path', 'port'),
                    socket,
                });
            }
            return socket;
        }
        // Some other status code that's not 200... need to re-play the HTTP
        // header "data" events onto the socket once the HTTP machinery is
        // attached so that the node core `http` can parse and handle the
        // error status code.
        // Close the original socket, and a new "fake" socket is returned
        // instead, so that the proxy doesn't get the HTTP request
        // written to it (which may contain `Authorization` headers or other
        // sensitive data).
        //
        // See: https://hackerone.com/reports/541502
        socket.destroy();
        const fakeSocket = new net.Socket({ writable: false });
        fakeSocket.readable = true;
        // Need to wait for the "socket" event to re-play the "data" events.
        req.once('socket', (s) => {
            debug('Replaying proxy buffer for failed request');
            (0, assert_1.default)(s.listenerCount('data') > 0);
            // Replay the "buffered" Buffer onto the fake `socket`, since at
            // this point the HTTP module machinery has been hooked up for
            // the user.
            s.push(buffered);
            s.push(null);
        });
        return fakeSocket;
    }
}
HttpsProxyAgent.protocols = ['http', 'https'];
exports.HttpsProxyAgent = HttpsProxyAgent;
function resume(socket) {
    socket.resume();
}
function omit(obj, ...keys) {
    const ret = {};
    let key;
    for (key in obj) {
        if (!keys.includes(key)) {
            ret[key] = obj[key];
        }
    }
    return ret;
}
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 86673:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseProxyResponse = void 0;
const debug_1 = __importDefault(__webpack_require__(38237));
const debug = (0, debug_1.default)('https-proxy-agent:parse-proxy-response');
function parseProxyResponse(socket) {
    return new Promise((resolve, reject) => {
        // we need to buffer any HTTP traffic that happens with the proxy before we get
        // the CONNECT response, so that if the response is anything other than an "200"
        // response code, then we can re-play the "data" events on the socket once the
        // HTTP parser is hooked up...
        let buffersLength = 0;
        const buffers = [];
        function read() {
            const b = socket.read();
            if (b)
                ondata(b);
            else
                socket.once('readable', read);
        }
        function cleanup() {
            socket.removeListener('end', onend);
            socket.removeListener('error', onerror);
            socket.removeListener('readable', read);
        }
        function onend() {
            cleanup();
            debug('onend');
            reject(new Error('Proxy connection ended before receiving CONNECT response'));
        }
        function onerror(err) {
            cleanup();
            debug('onerror %o', err);
            reject(err);
        }
        function ondata(b) {
            buffers.push(b);
            buffersLength += b.length;
            const buffered = Buffer.concat(buffers, buffersLength);
            const endOfHeaders = buffered.indexOf('\r\n\r\n');
            if (endOfHeaders === -1) {
                // keep buffering
                debug('have not received end of HTTP headers yet...');
                read();
                return;
            }
            const headerParts = buffered
                .slice(0, endOfHeaders)
                .toString('ascii')
                .split('\r\n');
            const firstLine = headerParts.shift();
            if (!firstLine) {
                socket.destroy();
                return reject(new Error('No header received from proxy CONNECT response'));
            }
            const firstLineParts = firstLine.split(' ');
            const statusCode = +firstLineParts[1];
            const statusText = firstLineParts.slice(2).join(' ');
            const headers = {};
            for (const header of headerParts) {
                if (!header)
                    continue;
                const firstColon = header.indexOf(':');
                if (firstColon === -1) {
                    socket.destroy();
                    return reject(new Error(`Invalid header from proxy CONNECT response: "${header}"`));
                }
                const key = header.slice(0, firstColon).toLowerCase();
                const value = header.slice(firstColon + 1).trimStart();
                const current = headers[key];
                if (typeof current === 'string') {
                    headers[key] = [current, value];
                }
                else if (Array.isArray(current)) {
                    current.push(value);
                }
                else {
                    headers[key] = value;
                }
            }
            debug('got proxy server response: %o %o', firstLine, headers);
            cleanup();
            resolve({
                connect: {
                    statusCode,
                    statusText,
                    headers,
                },
                buffered,
            });
        }
        socket.on('error', onerror);
        socket.on('end', onend);
        read();
    });
}
exports.parseProxyResponse = parseProxyResponse;
//# sourceMappingURL=parse-proxy-response.js.map

/***/ }),

/***/ 94975:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {



var paren = __webpack_require__(39991)

module.exports = function splitBy (string, separator, o) {
	if (string == null) throw Error('First argument should be a string')
	if (separator == null) throw Error('Separator should be a string or a RegExp')

	if (!o) o = {}
	else if (typeof o === 'string' || Array.isArray(o)) {
		o = {ignore: o}
	}

	if (o.escape == null) o.escape = true
	if (o.ignore == null) o.ignore = ['[]', '()', '{}', '<>', '""', "''", '``', '“”', '«»']
	else {
		if (typeof o.ignore === 'string') {o.ignore = [o.ignore]}

		o.ignore = o.ignore.map(function (pair) {
			// '"' → '""'
			if (pair.length === 1) pair = pair + pair
			return pair
		})
	}

	var tokens = paren.parse(string, {flat: true, brackets: o.ignore})
	var str = tokens[0]

	var parts = str.split(separator)

	// join parts separated by escape
	if (o.escape) {
		var cleanParts = []
		for (var i = 0; i < parts.length; i++) {
			var prev = parts[i]
			var part = parts[i + 1]

			if (prev[prev.length - 1] === '\\' && prev[prev.length - 2] !== '\\') {
				cleanParts.push(prev + separator + part)
				i++
			}
			else {
				cleanParts.push(prev)
			}
		}
		parts = cleanParts
	}

	// open parens pack & apply unquotes, if any
	for (var i = 0; i < parts.length; i++) {
		tokens[0] = parts[i]
		parts[i] = paren.stringify(tokens, {flat: true})
	}

	return parts
}


/***/ }),

/***/ 17410:
/***/ ((module) => {

module.exports = eval("require")("sharp");


/***/ }),

/***/ 90660:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   "App": () => (/* binding */ App),
/* harmony export */   "Canvas": () => (/* binding */ Canvas),
/* harmony export */   "CanvasGradient": () => (/* binding */ CanvasGradient),
/* harmony export */   "CanvasPattern": () => (/* binding */ CanvasPattern),
/* harmony export */   "CanvasRenderingContext2D": () => (/* binding */ CanvasRenderingContext2D),
/* harmony export */   "CanvasTexture": () => (/* binding */ CanvasTexture),
/* harmony export */   "DOMMatrix": () => (/* binding */ DOMMatrix),
/* harmony export */   "DOMPoint": () => (/* binding */ DOMPoint),
/* harmony export */   "DOMRect": () => (/* binding */ DOMRect),
/* harmony export */   "FontLibrary": () => (/* binding */ FontLibrary),
/* harmony export */   "Image": () => (/* binding */ Image),
/* harmony export */   "ImageData": () => (/* binding */ ImageData),
/* harmony export */   "Path2D": () => (/* binding */ Path2D),
/* harmony export */   "TextMetrics": () => (/* binding */ TextMetrics),
/* harmony export */   "Window": () => (/* binding */ Window),
/* harmony export */   "default": () => (/* reexport default export from named module */ _index_js__WEBPACK_IMPORTED_MODULE_0__),
/* harmony export */   "loadImage": () => (/* binding */ loadImage),
/* harmony export */   "loadImageData": () => (/* binding */ loadImageData)
/* harmony export */ });
/* harmony import */ var _index_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(18041);
//
// Skia Canvas — ES Module version
//



const {
  Canvas, CanvasGradient, CanvasPattern, CanvasTexture,
  Image, ImageData, loadImage, loadImageData,
  Path2D, DOMPoint, DOMMatrix, DOMRect,
  FontLibrary, TextMetrics,
  CanvasRenderingContext2D,
  App, Window,
} = _index_js__WEBPACK_IMPORTED_MODULE_0__




/***/ })

};

//# sourceMappingURL=660.index.js.map