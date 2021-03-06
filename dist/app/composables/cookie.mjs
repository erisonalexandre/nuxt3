import { ref, watch } from "vue";
import { parse, serialize } from "cookie-es";
import { appendHeader } from "h3";
import destr from "destr";
import { useNuxtApp } from "#app";
const CookieDefaults = {
  decode: (val) => destr(decodeURIComponent(val)),
  encode: (val) => encodeURIComponent(typeof val === "string" ? val : JSON.stringify(val))
};
export function useCookie(name, _opts) {
  const opts = { ...CookieDefaults, ..._opts };
  const cookies = readRawCookies(opts);
  const cookie = ref(cookies[name] ?? _opts.default?.());
  if (process.client) {
    watch(cookie, () => {
      writeClientCookie(name, cookie.value, opts);
    });
  } else if (process.server) {
    const initialValue = cookie.value;
    const nuxtApp = useNuxtApp();
    nuxtApp.hooks.hookOnce("app:rendered", () => {
      if (cookie.value !== initialValue) {
        writeServerCookie(useSSRRes(nuxtApp), name, cookie.value, opts);
      }
    });
  }
  return cookie;
}
function useSSRReq(nuxtApp = useNuxtApp()) {
  return nuxtApp.ssrContext?.req;
}
function useSSRRes(nuxtApp = useNuxtApp()) {
  return nuxtApp.ssrContext?.res;
}
function readRawCookies(opts = {}) {
  if (process.server) {
    return parse(useSSRReq().headers.cookie || "", opts);
  } else if (process.client) {
    return parse(document.cookie, opts);
  }
}
function serializeCookie(name, value, opts = {}) {
  if (value === null || value === void 0) {
    opts.maxAge = -1;
  }
  return serialize(name, value, opts);
}
function writeClientCookie(name, value, opts = {}) {
  if (process.client) {
    document.cookie = serializeCookie(name, value, opts);
  }
}
function writeServerCookie(res, name, value, opts = {}) {
  if (res) {
    appendHeader(res, "Set-Cookie", serializeCookie(name, value, opts));
  }
}
