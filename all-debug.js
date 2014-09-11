(function(global) {

  var g_define = global.define;
  var g_zpmjs = global.zpmjs;

  g_zpmjs || function() {

    var zpmjs_factory_cache = {};
    var zpmjs_exports_cache = {};

    var zpmjs_require = function(id) {

      if (zpmjs_exports_cache[id]) {
        return zpmjs_exports_cache[id];
      }

      var factory = zpmjs_factory_cache[id];

      if (!factory) {
        return;
      }

      var module = {
        id: id
      };

      zpmjs_exports_cache[id] =
        factory.call(global, zpmjs_require, module.exports = {}, module) ||
        module.exports;

      delete zpmjs_factory_cache[id];

      return zpmjs_exports_cache[id];
    };

    var zpm_define = function(id, factory) {

      if (zpmjs_require(id)) {
        return;
      }

      zpmjs_factory_cache[id] = factory;

      if (typeof g_define === "function" && (g_define.cmd || g_define.amd)) {
        g_define(id, [], factory);
      }
    };

    global.zpmjs = {
      use: function(module_ids, callback) {
        var mods = [];

        if (!(module_ids instanceof Array)) {
          module_ids = [module_ids];
        }

        for (var i = 0, l = module_ids.length; i < l; i++) {
          mods[i] = zpmjs_require(module_ids[i]);
        }

        callback.apply(global, mods);
      },
      require: zpmjs_require,
      define: zpm_define
    };

  }();

})(this);
zpmjs.define("tracker/2.0.2/tracker-debug", function(require, exports, module) {

  var win = window;

  if (win.Tracker) {
    return win.Tracker;
  }

  // data version.
  version = '1.0';

  var doc = win.document;
  var loc = win.location;
  var performance = win.performance;

  var startTime;
  var tracker_started = false;

  var FULL_URL = document.URL || "";
  var URL = FULL_URL.split(/\?|#|;jsessionid=/)[0];
  var SEED_NAME = "seed";
  var REF_NAME = "ref";
  var REF_UNLOAD_TIME_NAME = "ref-unload-time";
  var LOST_LOGS_NAME = "lost";
  var LOST_SPLITER = ",";
  var LOST_LOGS_DATA = [];
  // 超出指定时间的 window.name.ref 将失效。
  var REF_TIMEOUT = 1000;
  var BIPROFILE_NAME = 'BIProfile';
  var CLICK_PROFILE = 'clk';
  var PAGE_PROFILE = "page";
  var IFRAME_PROFILE = "iframe";
  var RE_SC_TYPE = /[?&]_scType=([^&#]+)/;

  var page_referrer = doc.referrer;

  // record ref string for any BIProfile, BIProfile name is the key.
  var REFERRERS = {};


  var detector = require("detector/2.0.1/detector-debug");
  var nameStorage = require("name-storage/1.2.0/index-debug");
  var ready = require("ready/0.0.0/index-debug");
  var Events = require("evt/0.2.1/evt-debug");

  var events = new Events();

  // defines the url where track data should be sent to
  var protocol = loc.protocol === "https:" ? "https:" : "http:";

  var BASE_URL = protocol + '//kcart.alipay.com/web/bi.do';
  var ACOOKIE_BASE_URL = protocol + '//log.mmstat.com/5.gif';
  var ACOOKIE_CALLBACK_URL = protocol + '//kcart.alipay.com/web/1.do';
  var RATE_LOAD = 0.125; // 1/8


  var encode = encodeURIComponent;

  function now() {
    return Date.now ? Date.now() : new Date().getTime();
  }

  // use IE 9 performance instead if applicable
  if (performance && performance.timing) {
    startTime = performance.timing.navigationStart;
  } else if (win._to && _to.start) {
    startTime = _to.start.getTime();
  } else {
    startTime = now();
  }

  // make key:value pair object to query param string.
  // queryparam({a: 1, b: 2}) ==> 'a=1&b=2')
  // queryparam({a: 1, b: 2}, '|', '\n')
  //
  // @param {Object} obj, key:value pair object.
  // @return {String}
  function queryparam(obj) {
    var stack = [];

    for (var property in obj) {
      if (property && obj.hasOwnProperty(property)) {

        var entry = encode(property);
        var value = String(obj[property]);
        if (value !== "") {
          entry += '=' + encode(value);
        }
        stack.push(entry);

      }
    }
    return stack.join('&');
  }

  function isObject(obj) {
    return Object.prototype.toString.call(obj) === '[object Object]';
  }

  // HTML's getAttribute is not available sometimes in IE.
  // and typeof node.getAttribute not a function.
  // @see http://msdn.microsoft.com/en-us/library/ms536429%28v=VS.85%29.aspx
  // @param {HTMLElement} element.
  // @param {String} attribute_name.
  function getAttribute(element, attribute_name) {
    var native_getAttribute;
    if (element && element.nodeType === 1 &&
      (native_getAttribute = element.getAttribute)) {

      try {
        return native_getAttribute.call(element, attribute_name, 2);
      } catch (ex) {}
    }
    return null;
  }

  function hasAttribute(element, attribute_name) {
    return element && element.nodeType === 1 && element.hasAttribute ?
      element.hasAttribute(attribute_name) :
      getAttribute(element, attribute_name) === null
  }


  // Tracker: represents a tracker working on the page.
  var Tracker = win.Tracker = function() {};

  var abVersion;
  var metas = doc.getElementsByTagName("meta");
  for (var i = 0, name, l = metas.length; i < l; i++) {
    name = getAttribute(metas[i], "name");
    if (name && name.toLowerCase() == "abtest") {
      abVersion = getAttribute(metas[i], "content");
      break;
    }
  }

  function hasACookie() {
    return /\bcna=/.test(document.cookie);
  }

  function removeArrayItem(array, item) {
    for (var i = 0, l = array.length; i < l; i++) {
      if (array[i] === item) {
        array.splice(i, 1);
        return array;
      }
    }
    return array;
  }

  // Send logs to server.
  // @param {String} url.
  function send(url) {
    LOST_LOGS_DATA.push(url);

    var image = new Image(1, 1);
    image.onload = image.onerror = image.onabort = function() {
      removeArrayItem(LOST_LOGS_DATA, url);
      image = image.onload = image.onerror = image.onabort = null;
    };

    image.src = url;
  }

  // addEventLister implementation
  // @param {HTMLElement} element.
  // @param {String} eventName.
  // @param {Function} handler.
  function addEventListener(element, eventName, handler) {
    if (!element) {
      return;
    }

    if (element.addEventListener) {
      element.addEventListener(eventName, handler, false);
    } else if (element.attachEvent) {
      element.attachEvent('on' + eventName, function(evt) {
        handler.call(element, evt);
      });
    }

  }

  // resolve target of event
  function getTarget(evt) {
    var node = evt.target || evt.srcElement;
    try {
      if (node && node.nodeType === 3) {
        return node.parentNode;
      }
    } catch (ex) {}
    return node;
  }

  function log(profile, data) {
    data[BIPROFILE_NAME] = profile;
    data.r = random();
    data.v = version;

    events.emit("log:" + profile, data);

    var query = queryparam(data);

    send(BASE_URL + "?" + query);

    REFERRERS[profile] = data.pg;

    if (hasACookie()) {
      return;
    }

    var acookie_query = queryparam({
      url: ACOOKIE_CALLBACK_URL + "?" + query
    });
    send(ACOOKIE_BASE_URL + "?" + acookie_query);
  }

  function log_seed(profile, seed) {
    return log(profile, {
      // [BIProfile=page]'s ref default "-", others default is URL.
      ref: REFERRERS[profile] || FULL_URL,
      pg: URL + "?seed=" + encode(seed)
    });
  }

  function random() {
    return Math.random();
  }

  // Send the lost data from referrer page.
  if (nameStorage) {
    var refTime = Number(nameStorage.getItem(REF_UNLOAD_TIME_NAME));
    if (startTime - refTime < REF_TIMEOUT) {
      if (!page_referrer) {
        page_referrer = nameStorage.getItem(REF_NAME);
      }

      var lost = nameStorage.getItem(LOST_LOGS_NAME);
      if (lost) {
        lost = lost.split(LOST_SPLITER);
        for (var i = 0, l = lost.length; i < l; i++) {
          send(lost[i]);
        }
      }
    }
    nameStorage.removeItem(REF_NAME);
    nameStorage.removeItem(REF_UNLOAD_TIME_NAME);
    nameStorage.removeItem(LOST_LOGS_NAME);
  }

  // Save the lost data for re-send on the next page.
  addEventListener(win, 'beforeunload', function() {
    if (!nameStorage) {
      return;
    }
    nameStorage.setItem(REF_NAME, FULL_URL);
    //nameStorage.setItem("seed", ACTIVE_SEED);
    nameStorage.setItem(REF_UNLOAD_TIME_NAME, now());
    nameStorage.setItem(LOST_LOGS_NAME, LOST_LOGS_DATA.join(","));
  });

  // send domready & load time properly, send pv immediately.
  function log_pv() {
    var profile = win.parent === win ? PAGE_PROFILE : IFRAME_PROFILE;

    // send PV
    var data = {
      ref: page_referrer || "-",
      pg: FULL_URL,
      screen: '-x-',
      color: '-', // TODO: 固定值，考慮清除掉。
      BIProfile: 'page'
    };
    // if the page in an iframe , the BIProfile is "iframe"

    if (win.screen) {
      data.screen = screen.width + "x" + screen.height;
      data.sc = screen.colorDepth + "-bit";
    }
     alert(loc == location);
     alert(loc === location);
    loc.hostname;
    //data.utmhn = loc.hostname;

    if (win.analytic_var) {
      data.ana = analytic_var;
      log_seed(CLICK_PROFILE, "deprecated-api-tracker-analytic_var");
    }

    var client_type_splitor = "|";
    var client_version_splitor = "/";
    var os, engine, browser, device;

    var prop_device = "device";
    var prop_os = "os";
    var prop_engine = "engine";
    var prop_browser = "browser";
    var prop_name = "name";
    var prop_version = "fullVersion";

    if (detector) {
      device = detector[prop_device][prop_name] + client_version_splitor + detector[prop_device][prop_version];
      os = detector[prop_os][prop_name] + client_version_splitor + detector[prop_os][prop_version];
      engine = detector[prop_engine][prop_name] + client_version_splitor + detector[prop_engine][prop_version];
      browser = detector[prop_browser][prop_name] + client_version_splitor + detector[prop_browser][prop_version];
    } else {
      var nodetector = "nodetector";
      var noversion = "-1";
      device = nodetector + client_version_splitor + noversion;
      os = nodetector + client_version_splitor + noversion;
      engine = nodetector + client_version_splitor + noversion;
      browser = nodetector + client_version_splitor + noversion;
    }
    data._clnt = [os, engine, browser, device].join(client_type_splitor);
    log(profile, data);
  }

  var readyTime;
  var loadTime;
  var is_send_load = false;

  function log_loadtime() {
    if (!readyTime || !loadTime) {
      return;
    }

    log("load", {
      ref: "-",
      pg: FULL_URL,
      tm: [readyTime, loadTime].join("x")
    });
  }

  function bind_loadtime() {

    function loadHandler() {
      if (is_send_load) {
        log_loadtime();
      }
    }

    ready(function() {
      readyTime = now() - startTime;
      loadHandler();
    });

    addEventListener(win, 'load', function() {
      loadTime = now() - startTime;
      loadHandler();
    });

    if (/^loaded|c/.test(doc.readyState)) {
      loadTime = now() - startTime;
      loadHandler();
    }
  }

  function clickHandler(evt) {
    var node = getTarget(evt);
    // node resolved as object but has no property
    // if mousedown triggered from disabled element in IE.
    if (!node || !node.nodeType) {
      return;
    }
    while (node && node.nodeName !== 'HTML' &&
      !hasAttribute(node, SEED_NAME)) {

      node = node.parentNode;
    }
    if (!node || node.nodeType !== 1 || node.nodeName === 'HTML') {
      return;
    }

    var seed = getAttribute(node, SEED_NAME);
    var args = {
      seed: seed
    };

    var href, match;
    if (node.nodeName === 'A') {
      href = getAttribute(node, "href") || "";
      if (href === FULL_URL || href.indexOf(FULL_URL + "#") === 0) {
        href = "";
      }
      match = href.match(RE_SC_TYPE);
      if (match) {
        args._scType = match[1];
      }
    }

    var data = {
      ref: REFERRERS[CLICK_PROFILE] || FULL_URL,
      pg: URL + "?" + queryparam(args)
    };

    events.emit("click", evt, node, data);

    log(CLICK_PROFILE, data);
  }

  addEventListener(doc, 'mousedown', clickHandler);
  addEventListener(doc, 'touchstart', clickHandler);

  // Lower level static method for manual click handler, designed for Ajax/Flash applications.
  Tracker.click = function(seed) {
    var parts = seed.split(":");
    var profile = CLICK_PROFILE;
    if (parts.length >= 2) {
      profile = parts[0];
      seed = parts[1];
    }
    return log_seed(profile, seed);
  };

  Tracker.log = function(seed, profile) {
    return log_seed(profile || "syslog", seed);
  };
  Tracker.error = function(seed) {
    return log_seed("syserr", seed);
  };
  // 监控统计特定 seed 的最大值、最小值、平均值、中位数等。
  Tracker.calc = function(seed, value) {
    var profile = "calc";
    return log(profile, {
      ref: REFERRERS[profile] || FULL_URL,
      pg: URL + "?" + queryparam({
        value: value,
        seed: seed
      })
    })
  };

  // @deprecated
  Tracker.getTarget = function(evt) {
    log_seed(CLICK_PROFILE, "deprecated-api-tracker-getTarget");
    return getTarget(evt);
  };

  // @deprecated
  Tracker.dispatchEvent = function(element, eventName, handler) {
    log_seed(CLICK_PROFILE, "deprecated-api-tracker-dispatchEvent");
    return addEventListener(element, eventName, handler);
  };

  // @deprecated
  Tracker.send = function(page, referrer, more) {
    log_seed(CLICK_PROFILE, "deprecated-api-tracker-send");
  };

  // extend from any sources that followed target into target
  // @deprecated
  Tracker.extend = function(target) {
    log_seed(CLICK_PROFILE, "deprecated-api-tracker-extend");

    for (var i = 1, l = arguments.length; i < l; i++) {
      for (var prop in arguments[i]) {
        if (arguments[i].hasOwnProperty(prop)) {
          target[prop] = arguments[i][prop];
        }
      }
    }
    return target;
  };


  Tracker.config = function(options) {
    BASE_URL = options.base_url || BASE_URL;
    ACOOKIE_BASE_URL = options.acookie_base_url || ACOOKIE_BASE_URL;
    ACOOKIE_CALLBACK_URL = options.acookie_callback_url | ACOOKIE_CALLBACK_URL;
    RATE_LOAD = options.rate_load || RATE_LOAD;
  };

  // 随机采样命中算法。
  // @param {Nuber} rate, 采样率，[0,1] 区间的数值。
  // @return {Boolean}
  function hit(rate) {
    return 0 === Math.floor(Math.random() / rate);
  }

  Tracker.start = function() {
    if (tracker_started) {
      return;
    }
    tracker_started = true;

    log_pv();

    // Send time info if hit.
    if (hit(RATE_LOAD)) {
      is_send_load = true;
      log_loadtime();
    }
  };

  //Tracker.on = events.on.bind(Tracker);
  Tracker.on = function(eventName, handler) {
    events.on(eventName, handler);
    return Tracker;
  };
  //Tracker.off = events.off.bind(Tracker);
  Tracker.off = function(eventName, handler) {
    events.off(eventName, handler);
    return Tracker;
  };

  bind_loadtime();

  module.exports = Tracker;

});
zpmjs.define("ready/0.0.0/index-debug", function(require, exports, module) {

  var win = window;
  var doc = document;

  var handlers = [];

  var isTop = self === top;
  var documentElement = doc.documentElement;
  var hack = documentElement.doScroll;

  var domContentLoaded = "DOMContentLoaded";
  var onreadystatechange = "onreadystatechange";
  var addEventListener = "addEventListener";
  var attachEvent = "attachEvent";
  var load = "load";
  var readyState = "readyState";

  var RE_DOMREADY = hack ? /^loaded|^c/ : /^loaded|c/;
  var isDOMReady = RE_DOMREADY.test(doc[readyState]);

  var readyHandler;

  function flush() {
    if (isDOMReady) {
      return;
    }
    isDOMReady = true;

    for (var i = 0, l = handlers.length; i < l; i++) {
      handlers[i]();
    }
  }

  function checkReady() {
    try {
      documentElement.doScroll("left");
    } catch (ex) {
      return setTimeout(checkReady, 50);
    }
    flush();
  }

  if (doc[addEventListener]) {

    readyHandler = function() {
      doc.removeEventListener(domContentLoaded, readyHandler, false);
      flush();
    };

    doc[addEventListener](domContentLoaded, readyHandler, false);
    doc[addEventListener](load, readyHandler, false);

  } else if (hack) {

    readyHandler = function() {
      if (/^c/.test(doc[readyState])) {
        doc.detachEvent(onreadystatechange, readyHandler);
        flush();
      }
    };

    doc[attachEvent](onreadystatechange, readyHandler);
    doc[attachEvent]("on" + load, readyHandler);

    checkReady();
  }

  if (isDOMReady) {
    flush();
  }

  var domready = function(handler) {
    isDOMReady ? handler() : handlers.push(handler);
  };

  module.exports = domready;

});
zpmjs.define("detector/2.0.1/detector-debug", function(require, exports, module) {

  var detector = {};
  var NA_VERSION = "-1";
  var window = this;
  var external;
  var re_msie = /\b(?:msie |ie |trident\/[0-9].*rv[ :])([0-9.]+)/;

  function toString(object) {
    return Object.prototype.toString.call(object);
  }

  function isObject(object) {
    return toString(object) === "[object Object]";
  }

  function isFunction(object) {
    return toString(object) === "[object Function]";
  }

  function each(object, factory, argument) {
    for (var i = 0, b, l = object.length; i < l; i++) {
      if (factory.call(object, object[i], i) === false) {
        break;
      }
    }
  }

  // 硬件设备信息识别表达式。
  // 使用数组可以按优先级排序。
  var DEVICES = [
    ["nokia",
      function(ua) {
        // 不能将两个表达式合并，因为可能出现 "nokia; nokia 960"
        // 这种情况下会优先识别出 nokia/-1
        if (ua.indexOf("nokia ") !== -1) {
          return /\bnokia ([0-9]+)?/;
        } else if (ua.indexOf("noain") !== -1) {
          return /\bnoain ([a-z0-9]+)/;
        } else {
          return /\bnokia([a-z0-9]+)?/;
        }
      }
    ],
    // 三星有 Android 和 WP 设备。
    ["samsung",
      function(ua) {
        if (ua.indexOf("samsung") !== -1) {
          return /\bsamsung(?:\-gt)?[ \-]([a-z0-9\-]+)/;
        } else {
          return /\b(?:gt|sch)[ \-]([a-z0-9\-]+)/;
        }
      }
    ],
    ["wp",
      function(ua) {
        return ua.indexOf("windows phone ") !== -1 ||
          ua.indexOf("xblwp") !== -1 ||
          ua.indexOf("zunewp") !== -1 ||
          ua.indexOf("windows ce") !== -1;
      }
    ],
    ["pc", "windows"],
    ["ipad", "ipad"],
    // ipod 规则应置于 iphone 之前。
    ["ipod", "ipod"],
    ["iphone", /\biphone\b|\biph(\d)/],
    ["mac", "macintosh"],
    ["mi", /\bmi[ \-]?([a-z0-9 ]+(?= build))/],
    ["aliyun", /\baliyunos\b(?:[\-](\d+))?/],
    ["meizu", /\b(?:meizu\/|m)([0-9]+)\b/],
    ["nexus", /\bnexus ([0-9s.]+)/],
    ["huawei",
      function(ua) {
        var re_mediapad = /\bmediapad (.+?)(?= build\/huaweimediapad\b)/;
        if (ua.indexOf("huawei-huawei") !== -1) {
          return /\bhuawei\-huawei\-([a-z0-9\-]+)/;
        } else if (re_mediapad.test(ua)) {
          return re_mediapad;
        } else {
          return /\bhuawei[ _\-]?([a-z0-9]+)/;
        }
      }
    ],
    ["lenovo",
      function(ua) {
        if (ua.indexOf("lenovo-lenovo") !== -1) {
          return /\blenovo\-lenovo[ \-]([a-z0-9]+)/;
        } else {
          return /\blenovo[ \-]?([a-z0-9]+)/;
        }
      }
    ],
    // 中兴
    ["zte",
      function(ua) {
        if (/\bzte\-[tu]/.test(ua)) {
          return /\bzte-[tu][ _\-]?([a-su-z0-9\+]+)/;
        } else {
          return /\bzte[ _\-]?([a-su-z0-9\+]+)/;
        }
      }
    ],
    // 步步高
    ["vivo", /\bvivo(?: ([a-z0-9]+))?/],
    ["htc",
      function(ua) {
        if (/\bhtc[a-z0-9 _\-]+(?= build\b)/.test(ua)) {
          return /\bhtc[ _\-]?([a-z0-9 ]+(?= build))/;
        } else {
          return /\bhtc[ _\-]?([a-z0-9 ]+)/;
        }
      }
    ],
    ["oppo", /\boppo[_]([a-z0-9]+)/],
    ["konka", /\bkonka[_\-]([a-z0-9]+)/],
    ["sonyericsson", /\bmt([a-z0-9]+)/],
    ["coolpad", /\bcoolpad[_ ]?([a-z0-9]+)/],
    ["lg", /\blg[\-]([a-z0-9]+)/],
    ["android", /\bandroid\b|\badr\b/],
    ["blackberry", "blackberry"]
  ];
  // 操作系统信息识别表达式
  var OS = [
    ["wp",
      function(ua) {
        if (ua.indexOf("windows phone ") !== -1) {
          return /\bwindows phone (?:os )?([0-9.]+)/;
        } else if (ua.indexOf("xblwp") !== -1) {
          return /\bxblwp([0-9.]+)/;
        } else if (ua.indexOf("zunewp") !== -1) {
          return /\bzunewp([0-9.]+)/;
        }
        return "windows phone";
      }
    ],
    ["windows", /\bwindows nt ([0-9.]+)/],
    ["macosx", /\bmac os x ([0-9._]+)/],
    ["ios",
      function(ua) {
        if (/\bcpu(?: iphone)? os /.test(ua)) {
          return /\bcpu(?: iphone)? os ([0-9._]+)/;
        } else if (ua.indexOf("iph os ") !== -1) {
          return /\biph os ([0-9_]+)/;
        } else {
          return /\bios\b/;
        }
      }
    ],
    ["yunos", /\baliyunos ([0-9.]+)/],
    ["android",
      function(ua) {
        if (ua.indexOf("android") >= 0) {
          return /\bandroid[ \/-]?([0-9.x]+)?/;
        } else if (ua.indexOf("adr") >= 0) {
          if (ua.indexOf("mqqbrowser") >= 0) {
            return /\badr[ ]\(linux; u; ([0-9.]+)?/;
          } else {
            return /\badr(?:[ ]([0-9.]+))?/;
          }
        }
        return "android";
        //return /\b(?:android|\badr)(?:[\/\- ](?:\(linux; u; )?)?([0-9.x]+)?/;
      }
    ],
    ["chromeos", /\bcros i686 ([0-9.]+)/],
    ["linux", "linux"],
    ["windowsce", /\bwindows ce(?: ([0-9.]+))?/],
    ["symbian", /\bsymbian(?:os)?\/([0-9.]+)/],
    ["blackberry", "blackberry"]
  ];

  /*
   * 解析使用 Trident 内核的浏览器的 `浏览器模式` 和 `文档模式` 信息。
   * @param {String} ua, userAgent string.
   * @return {Object}
   */
  function IEMode(ua) {
    if (!re_msie.test(ua)) {
      return null;
    }

    var m,
      engineMode, engineVersion,
      browserMode, browserVersion,
      compatible = false;

    // IE8 及其以上提供有 Trident 信息，
    // 默认的兼容模式，UA 中 Trident 版本不发生变化。
    if (ua.indexOf("trident/") !== -1) {
      m = /\btrident\/([0-9.]+)/.exec(ua);
      if (m && m.length >= 2) {
        // 真实引擎版本。
        engineVersion = m[1];
        var v_version = m[1].split(".");
        v_version[0] = parseInt(v_version[0], 10) + 4;
        browserVersion = v_version.join(".");
      }
    }

    m = re_msie.exec(ua);
    browserMode = m[1];
    var v_mode = m[1].split(".");
    if ("undefined" === typeof browserVersion) {
      browserVersion = browserMode;
    }
    v_mode[0] = parseInt(v_mode[0], 10) - 4;
    engineMode = v_mode.join(".");
    if ("undefined" === typeof engineVersion) {
      engineVersion = engineMode;
    }

    return {
      browserVersion: browserVersion,
      browserMode: browserMode,
      engineVersion: engineVersion,
      engineMode: engineMode,
      compatible: engineVersion !== engineMode
    };
  }
  /**
   * 针对同源的 TheWorld 和 360 的 external 对象进行检测。
   * @param {String} key, 关键字，用于检测浏览器的安装路径中出现的关键字。
   * @return {Undefined,Boolean,Object} 返回 undefined 或 false 表示检测未命中。
   */
  function checkTW360External(key) {
    if (!external) {
      return;
    } // return undefined.
    try {
      //        360安装路径：
      //        C:%5CPROGRA~1%5C360%5C360se3%5C360SE.exe
      var runpath = external.twGetRunPath.toLowerCase();
      // 360SE 3.x ~ 5.x support.
      // 暴露的 external.twGetVersion 和 external.twGetSecurityID 均为 undefined。
      // 因此只能用 try/catch 而无法使用特性判断。
      var security = external.twGetSecurityID(window);
      var version = external.twGetVersion(security);

      if (runpath && runpath.indexOf(key) === -1) {
        return false;
      }
      if (version) {
        return {
          version: version
        };
      }
    } catch (ex) {}
  }

  var ENGINE = [
    ["trident", re_msie],
    //["blink", /blink\/([0-9.+]+)/],
    ["webkit", /\bapplewebkit[\/]?([0-9.+]+)/],
    ["gecko", /\bgecko\/(\d+)/],
    ["presto", /\bpresto\/([0-9.]+)/],
    ["androidwebkit", /\bandroidwebkit\/([0-9.]+)/],
    ["coolpadwebkit", /\bcoolpadwebkit\/([0-9.]+)/],
    ["u2", /\bu2\/([0-9.]+)/],
    ["u3", /\bu3\/([0-9.]+)/]
  ];
  var BROWSER = [
    // Sogou.
    ["sg", / se ([0-9.x]+)/],
    // TheWorld (世界之窗)
    // 由于裙带关系，TW API 与 360 高度重合。
    // 只能通过 UA 和程序安装路径中的应用程序名来区分。
    // TheWorld 的 UA 比 360 更靠谱，所有将 TheWorld 的规则放置到 360 之前。
    ["tw",
      function(ua) {
        var x = checkTW360External("theworld");
        if (typeof x !== "undefined") {
          return x;
        }
        return "theworld";
      }
    ],
    // 360SE, 360EE.
    ["360",
      function(ua) {
        var x = checkTW360External("360se");
        if (typeof x !== "undefined") {
          return x;
        }
        if (ua.indexOf("360 aphone browser") !== -1) {
          return /\b360 aphone browser \(([^\)]+)\)/;
        }
        return /\b360(?:se|ee|chrome|browser)\b/;
      }
    ],
    // Maxthon
    ["mx",
      function(ua) {
        try {
          if (external && (external.mxVersion || external.max_version)) {
            return {
              version: external.mxVersion || external.max_version
            };
          }
        } catch (ex) {}
        return /\bmaxthon(?:[ \/]([0-9.]+))?/;
      }
    ],
    ["qq", /\bm?qqbrowser\/([0-9.]+)/],
    ["green", "greenbrowser"],
    ["tt", /\btencenttraveler ([0-9.]+)/],
    ["lb",
      function(ua) {
        if (ua.indexOf("lbbrowser") === -1) {
          return false;
        }
        var version;
        try {
          if (external && external.LiebaoGetVersion) {
            version = external.LiebaoGetVersion();
          }
        } catch (ex) {}
        return {
          version: version || NA_VERSION
        };
      }
    ],
    ["tao", /\btaobrowser\/([0-9.]+)/],
    ["fs", /\bcoolnovo\/([0-9.]+)/],
    ["sy", "saayaa"],
    // 有基于 Chromniun 的急速模式和基于 IE 的兼容模式。必须在 IE 的规则之前。
    ["baidu", /\bbidubrowser[ \/]([0-9.x]+)/],
    // 后面会做修复版本号，这里只要能识别是 IE 即可。
    ["ie", re_msie],
    ["mi", /\bmiuibrowser\/([0-9.]+)/],
    // Opera 15 之后开始使用 Chromniun 内核，需要放在 Chrome 的规则之前。
    ["opera",
      function(ua) {
        var re_opera_old = /\bopera.+version\/([0-9.ab]+)/;
        var re_opera_new = /\bopr\/([0-9.]+)/;
        return re_opera_old.test(ua) ? re_opera_old : re_opera_new;
      }
    ],
    ["yandex", /yabrowser\/([0-9.]+)/],
    // 支付宝手机客户端
    ["ali-ap",
      function(ua) {
        if (ua.indexOf("aliapp") > 0) {
          return /\baliapp\(ap\/([0-9.]+)\)/;
        } else {
          return /\balipayclient\/([0-9.]+)\b/;
        }
      }
    ],
    // 支付宝平板客户端
    ["ali-ap-pd", /\baliapp\(ap-pd\/([0-9.]+)\)/],
    // 支付宝商户客户端
    ["ali-am", /\baliapp\(am\/([0-9.]+)\)/],
    // 淘宝手机客户端
    ["ali-tb", /\baliapp\(tb\/([0-9.]+)\)/],
    // 淘宝平板客户端
    ["ali-tb-pd", /\baliapp\(tb-pd\/([0-9.]+)\)/],
    // 天猫手机客户端
    ["ali-tm", /\baliapp\(tm\/([0-9.]+)\)/],
    // 天猫平板客户端
    ["ali-tm-pd", /\baliapp\(tm-pd\/([0-9.]+)\)/],
    ["chrome", / (?:chrome|crios|crmo)\/([0-9.]+)/],
    // UC 浏览器，可能会被识别为 Android 浏览器，规则需要前置。
    ["uc",
      function(ua) {
        if (ua.indexOf("ucbrowser/") >= 0) {
          return /\bucbrowser\/([0-9.]+)/;
        } else if (/\buc\/[0-9]/.test(ua)) {
          return /\buc\/([0-9.]+)/;
        } else if (ua.indexOf("ucweb") >= 0) {
          // `ucweb/2.0` is compony info.
          // `UCWEB8.7.2.214/145/800` is browser info.
          return /\bucweb([0-9.]+)?/;
        } else {
          return /\b(?:ucbrowser|uc)\b/;
        }
      }
    ],
    // Android 默认浏览器。该规则需要在 safari 之前。
    ["android",
      function(ua) {
        if (ua.indexOf("android") === -1) {
          return;
        }
        return /\bversion\/([0-9.]+(?: beta)?)/;
      }
    ],
    ["safari", /\bversion\/([0-9.]+(?: beta)?)(?: mobile(?:\/[a-z0-9]+)?)? safari\//],
    // 如果不能被识别为 Safari，则猜测是 WebView。
    ["webview", /\bcpu(?: iphone)? os (?:[0-9._]+).+\bapplewebkit\b/],
    ["firefox", /\bfirefox\/([0-9.ab]+)/],
    ["nokia", /\bnokiabrowser\/([0-9.]+)/]
  ];

  /**
   * UserAgent Detector.
   * @param {String} ua, userAgent.
   * @param {Object} expression
   * @return {Object}
   *    返回 null 表示当前表达式未匹配成功。
   */
  function detect(name, expression, ua) {
    var expr = isFunction(expression) ? expression.call(null, ua) : expression;
    if (!expr) {
      return null;
    }
    var info = {
      name: name,
      version: NA_VERSION,
      codename: ""
    };
    var t = toString(expr);
    if (expr === true) {
      return info;
    } else if (t === "[object String]") {
      if (ua.indexOf(expr) !== -1) {
        return info;
      }
    } else if (isObject(expr)) { // Object
      if (expr.hasOwnProperty("version")) {
        info.version = expr.version;
      }
      return info;
    } else if (expr.exec) { // RegExp
      var m = expr.exec(ua);
      if (m) {
        if (m.length >= 2 && m[1]) {
          info.version = m[1].replace(/_/g, ".");
        } else {
          info.version = NA_VERSION;
        }
        return info;
      }
    }
  }

  var na = {
    name: "na",
    version: NA_VERSION
  };
  // 初始化识别。
  function init(ua, patterns, factory, detector) {
    var detected = na;
    each(patterns, function(pattern) {
      var d = detect(pattern[0], pattern[1], ua);
      if (d) {
        detected = d;
        return false;
      }
    });
    factory.call(detector, detected.name, detected.version);
  }

  /**
   * 解析 UserAgent 字符串
   * @param {String} ua, userAgent string.
   * @return {Object}
   */
  var parse = function(ua) {
    ua = (ua || "").toLowerCase();
    var d = {};

    init(ua, DEVICES, function(name, version) {
      var v = parseFloat(version);
      d.device = {
        name: name,
        version: v,
        fullVersion: version
      };
      d.device[name] = v;
    }, d);

    init(ua, OS, function(name, version) {
      var v = parseFloat(version);
      d.os = {
        name: name,
        version: v,
        fullVersion: version
      };
      d.os[name] = v;
    }, d);

    var ieCore = IEMode(ua);

    init(ua, ENGINE, function(name, version) {
      var mode = version;
      // IE 内核的浏览器，修复版本号及兼容模式。
      if (ieCore) {
        version = ieCore.engineVersion || ieCore.engineMode;
        mode = ieCore.engineMode;
      }
      var v = parseFloat(version);
      d.engine = {
        name: name,
        version: v,
        fullVersion: version,
        mode: parseFloat(mode),
        fullMode: mode,
        compatible: ieCore ? ieCore.compatible : false
      };
      d.engine[name] = v;
    }, d);

    init(ua, BROWSER, function(name, version) {
      var mode = version;
      // IE 内核的浏览器，修复浏览器版本及兼容模式。
      if (ieCore) {
        // 仅修改 IE 浏览器的版本，其他 IE 内核的版本不修改。
        if (name === "ie") {
          version = ieCore.browserVersion;
        }
        mode = ieCore.browserMode;
      }
      var v = parseFloat(version);
      d.browser = {
        name: name,
        version: v,
        fullVersion: version,
        mode: parseFloat(mode),
        fullMode: mode,
        compatible: ieCore ? ieCore.compatible : false
      };
      d.browser[name] = v;
    }, d);
    return d;
  };


  // NodeJS.
  if (typeof process === "object" && process.toString() === "[object process]") {

    // 加载更多的规则。
    var morerule = module["require"]("./morerule");
    [].unshift.apply(DEVICES, morerule.DEVICES || []);
    [].unshift.apply(OS, morerule.OS || []);
    [].unshift.apply(BROWSER, morerule.BROWSER || []);
    [].unshift.apply(ENGINE, morerule.ENGINE || []);

  } else {

    var userAgent = navigator.userAgent || "";
    //var platform = navigator.platform || "";
    var appVersion = navigator.appVersion || "";
    var vendor = navigator.vendor || "";
    external = window.external;

    detector = parse(userAgent + " " + appVersion + " " + vendor);
    window.detector = detector;

  }


  // exports `parse()` API anyway.
  detector.parse = parse;

  module.exports = detector;

});
zpmjs.define("name-storage/1.2.0/index-debug", function(require, exports, module) {
  // nameStorage
  //
  // 利用 window.name 实现跨页面跨域的数据传输。

  var win = window;

  var SCHEME = "nameStorage:";
  //var RE_NAMES = /^nameStorage:([^?]*)(?:\?(?:([^=]+)=([^&]*))*)?/g;
  var RE_PAIR = /^([^=]+)(?:=(.*))?$/;
  var Q = "?";
  var EQ = "=";
  var AND = "&";

  var encode = encodeURIComponent;
  var decode = decodeURIComponent;

  var STORAGE = {};
  var ORIGIN_NAME;

  var nameStorage = {};

  // 解析并初始化 name 数据。
  // 标准的 nameStorage 数据格式为 `nameStorage:origin-name?key=value`
  // @param {String} name.
  (function parse(name) {

    if (name && name.indexOf(SCHEME) === 0) {

      var match = name.split(/[:?]/);

      match.shift(); // scheme: match[0];
      ORIGIN_NAME = decode(match.shift()) || ""; // match[1]

      var params = match.join(""); // match[2,...]

      var pairs = params.split(AND);
      for (var i = 0, pair, key, value, l = pairs.length; i < l; i++) {
        pair = pairs[i].match(RE_PAIR);
        if (!pair || !pair[1]) {
          continue;
        }

        key = decode(pair[1]);
        value = decode(pair[2]) || "";

        STORAGE[key] = value;
      }

    } else {

      ORIGIN_NAME = name || "";

    }

  })(win.name);

  // 写入数据。
  // @param {String} key, 键名。
  // @param {String} value, 键值。
  nameStorage.setItem = function(key, value) {
    if (!key || "undefined" === typeof value) {
      return;
    }
    STORAGE[key] = String(value);
    save();
  };

  // 读取数据。
  // @param {String} key, 键名。
  // @return {String} 键值。如果不存在，则返回 `null`。
  nameStorage.getItem = function(key) {
    return STORAGE.hasOwnProperty(key) ? STORAGE[key] : null;
  };

  // 移除数据。
  // @param {String} key, 键名。
  nameStorage.removeItem = function(key) {
    if (!STORAGE.hasOwnProperty(key)) {
      return;
    }
    STORAGE[key] = null;
    delete STORAGE[key];
    save();
  };

  // 清空 nameStorage。
  nameStorage.clear = function() {
    STORAGE = {};
    save();
  };

  nameStorage.valueOf = function() {
    return STORAGE;
  };

  nameStorage.toString = function() {
    var name = win.name;
    return name.indexOf(SCHEME) === 0 ? name : SCHEME + name;
  };

  // 保存数据到 window.name
  // 如果没有存储数据，则恢复原始窗口名称(window.name)。
  function save() {
    var pairs = [];
    var empty = true;
    var value;

    for (var key in STORAGE) {
      if (!STORAGE.hasOwnProperty(key)) {
        continue;
      }
      empty = false;

      value = STORAGE[key] || "";
      pairs.push(encode(key) + EQ + encode(value));

    }

    win.name = empty ? ORIGIN_NAME :
      SCHEME + encode(ORIGIN_NAME) + Q + pairs.join(AND);
  }


  win.nameStorage = nameStorage;

  module.exports = nameStorage;

});
zpmjs.define("evt/0.2.1/evt-debug", function(require, exports, module) {

  function Event() {};

  Event.prototype = {

    on: function(eventName, handler) {
      var me = this;
      var listeners = me._ || (me._ = {});
      var list = listeners[eventName] || (listeners[eventName] = []);
      list.push(handler);
      return me;
    },

    off: function(eventName, handler) {
      var me = this;
      var listeners = me._;

      // Remove *all* events
      if (listeners) {

        if (!(eventName || handler)) {
          me._ = {};
          return me;
        }

        var list = listeners[eventName];
        if (list) {
          if (handler) {
            for (var i = list.length - 1; i >= 0; i--) {
              if (list[i] === handler) {
                list.splice(i, 1);
                break;
              }
            }
          } else {
            delete listeners[eventName];
          }
        }

      }

      return me;
    },

    emit: function(name) {
      var me = this;
      var listeners = me._;

      if (listeners) {

        var list = listeners[name];
        var args = Array.prototype.slice.call(arguments);
        args.shift();

        if (list) {
          // Copy callback lists to prevent modification
          list = list.slice();

          // Execute event callbacks, use index because it's the faster.
          for (var i = 0, len = list.length; i < len; i++) {
            list[i].apply(me, args);
          }
        }

      }

      return me;
    }

  };

  module.exports = Event;

});
zpmjs.define("tracker-id/0.1.0/index-debug", function(require, exports, module) {
  // trackerId 编码规则：
  // `W` 或 `A` 前缀用来识别来自 Web 或 App；
  // 32位 不唯一的 MD5 值，保证不同用户、不同会话间不重复；
  // 4位递增序号，用来保证同一会话不重复。

  var md5 = require("md5/2.0.0/md5-debug");
  var ready = require("ready/0.0.0/index-debug");
  var Tracker = require("tracker/2.0.2/tracker-debug");

  var param_name = "trackerId";

  function genBaseID() {
    return md5(doc.URL + doc.cookie + (new Date().getTime()) + Math.random()).toUpperCase();
  }

  function getAttribute(element, name) {
    if (element && element.getAttribute) {
      return element.getAttribute(name, 4);
    }
  }

  var doc = document;
  // W: Web.
  // A: App.
  var PREFIX = "W";
  var BASE_ID = genBaseID();

  var inc = 0;

  function increase() {
    if (inc >= 9000) {
      BASE_ID = genBaseID();
      inc = 0;
    }
    var string = "000" + (inc++);
    return string.substr(string.length - 4);
  }

  function getID() {
    return PREFIX + BASE_ID + increase();
  }

  Tracker.on("click", function(evt, element, data) {
    var type = (getAttribute(element, "type") || element.type).toUpperCase();
    var tagName = element.tagName;
    if (
      (tagName === "INPUT" || tagName === "BUTTON") &&
      (type === "SUBMIT" || type === "IMAGE")
    ) {

      var trackerId = getID();

      data.trackerId = trackerId;

      var form = element.form;
      var trackerid_input = form._trackerid_input;

      trackerid_input.value = trackerId;
    }
  });

  ready(function() {
    var forms = doc.forms;

    for (var i = 0, l = forms.length; i < l; i++) {

      var iptTrackerID = doc.createElement("input");
      iptTrackerID.type = "hidden";
      iptTrackerID.name = param_name;
      forms[i].appendChild(iptTrackerID);
      forms[i]._trackerid_input = iptTrackerID;

    }
  });

});
zpmjs.define("md5/2.0.0/md5-debug", function(require, exports, module) {
  /*
   * JavaScript MD5 1.0.1
   * https://github.com/blueimp/JavaScript-MD5
   *
   * Copyright 2011, Sebastian Tschan
   * https://blueimp.net
   *
   * Licensed under the MIT license:
   * http://www.opensource.org/licenses/MIT
   *
   * Based on
   * A JavaScript implementation of the RSA Data Security, Inc. MD5 Message
   * Digest Algorithm, as defined in RFC 1321.
   * Version 2.2 Copyright (C) Paul Johnston 1999 - 2009
   * Other contributors: Greg Holt, Andrew Kepert, Ydnar, Lostinet
   * Distributed under the BSD License
   * See http://pajhome.org.uk/crypt/md5 for more info.
   */

  /*jslint bitwise: true */
  /*global unescape, define */



  /*
   * Add integers, wrapping at 2^32. This uses 16-bit operations internally
   * to work around bugs in some JS interpreters.
   */
  function safe_add(x, y) {
    var lsw = (x & 0xFFFF) + (y & 0xFFFF),
      msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xFFFF);
  }

  /*
   * Bitwise rotate a 32-bit number to the left.
   */
  function bit_rol(num, cnt) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  /*
   * These functions implement the four basic operations the algorithm uses.
   */
  function md5_cmn(q, a, b, x, s, t) {
    return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b);
  }

  function md5_ff(a, b, c, d, x, s, t) {
    return md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }

  function md5_gg(a, b, c, d, x, s, t) {
    return md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }

  function md5_hh(a, b, c, d, x, s, t) {
    return md5_cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function md5_ii(a, b, c, d, x, s, t) {
    return md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
  }

  /*
   * Calculate the MD5 of an array of little-endian words, and a bit length.
   */
  function binl_md5(x, len) {
    /* append padding */
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;

    var i, olda, oldb, oldc, oldd,
      a = 1732584193,
      b = -271733879,
      c = -1732584194,
      d = 271733878;

    for (i = 0; i < x.length; i += 16) {
      olda = a;
      oldb = b;
      oldc = c;
      oldd = d;

      a = md5_ff(a, b, c, d, x[i], 7, -680876936);
      d = md5_ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5_ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5_ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5_ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5_ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5_ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5_ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5_ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5_ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5_ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5_ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5_ff(b, c, d, a, x[i + 15], 22, 1236535329);

      a = md5_gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5_gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5_gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5_gg(b, c, d, a, x[i], 20, -373897302);
      a = md5_gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5_gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5_gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5_gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5_gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5_gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5_gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5_gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5_gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5_gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);

      a = md5_hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5_hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5_hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5_hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5_hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5_hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5_hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5_hh(d, a, b, c, x[i], 11, -358537222);
      c = md5_hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5_hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5_hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5_hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5_hh(b, c, d, a, x[i + 2], 23, -995338651);

      a = md5_ii(a, b, c, d, x[i], 6, -198630844);
      d = md5_ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5_ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5_ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5_ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5_ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5_ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5_ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5_ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5_ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5_ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5_ii(b, c, d, a, x[i + 9], 21, -343485551);

      a = safe_add(a, olda);
      b = safe_add(b, oldb);
      c = safe_add(c, oldc);
      d = safe_add(d, oldd);
    }
    return [a, b, c, d];
  }

  /*
   * Convert an array of little-endian words to a string
   */
  function binl2rstr(input) {
    var i,
      output = '';
    for (i = 0; i < input.length * 32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xFF);
    }
    return output;
  }

  /*
   * Convert a raw string to an array of little-endian words
   * Characters >255 have their high-byte silently ignored.
   */
  function rstr2binl(input) {
    var i,
      output = [];
    output[(input.length >> 2) - 1] = undefined;
    for (i = 0; i < output.length; i += 1) {
      output[i] = 0;
    }
    for (i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xFF) << (i % 32);
    }
    return output;
  }

  /*
   * Calculate the MD5 of a raw string
   */
  function rstr_md5(s) {
    return binl2rstr(binl_md5(rstr2binl(s), s.length * 8));
  }

  /*
   * Calculate the HMAC-MD5, of a key and some data (raw strings)
   */
  function rstr_hmac_md5(key, data) {
    var i,
      bkey = rstr2binl(key),
      ipad = [],
      opad = [],
      hash;
    ipad[15] = opad[15] = undefined;
    if (bkey.length > 16) {
      bkey = binl_md5(bkey, key.length * 8);
    }
    for (i = 0; i < 16; i += 1) {
      ipad[i] = bkey[i] ^ 0x36363636;
      opad[i] = bkey[i] ^ 0x5C5C5C5C;
    }
    hash = binl_md5(ipad.concat(rstr2binl(data)), 512 + data.length * 8);
    return binl2rstr(binl_md5(opad.concat(hash), 512 + 128));
  }

  /*
   * Convert a raw string to a hex string
   */
  function rstr2hex(input) {
    var hex_tab = '0123456789abcdef',
      output = '',
      x,
      i;
    for (i = 0; i < input.length; i += 1) {
      x = input.charCodeAt(i);
      output += hex_tab.charAt((x >>> 4) & 0x0F) +
        hex_tab.charAt(x & 0x0F);
    }
    return output;
  }

  /*
   * Encode a string as utf-8
   */
  function str2rstr_utf8(input) {
    return unescape(encodeURIComponent(input));
  }

  /*
   * Take string arguments and return either raw or hex encoded strings
   */
  function raw_md5(s) {
    return rstr_md5(str2rstr_utf8(s));
  }

  function hex_md5(s) {
    return rstr2hex(raw_md5(s));
  }

  function raw_hmac_md5(k, d) {
    return rstr_hmac_md5(str2rstr_utf8(k), str2rstr_utf8(d));
  }

  function hex_hmac_md5(k, d) {
    return rstr2hex(raw_hmac_md5(k, d));
  }

  function md5(string, key, raw) {
    if (!key) {
      if (!raw) {
        return hex_md5(string);
      }
      return raw_md5(string);
    }
    if (!raw) {
      return hex_hmac_md5(key, string);
    }
    return raw_hmac_md5(key, string);
  }

  module.exports = md5;

});
