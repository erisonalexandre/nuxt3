import { defineNuxtPlugin } from "#app";
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook("app:mounted", () => {
    const el = document.createElement("div");
    el.id = "nuxt-progress";
    document.body.appendChild(el);
    el.style.position = "fixed";
    el.style.backgroundColor = "black";
    el.style.height = "2px";
    el.style.top = "0px";
    el.style.left = "0px";
    el.style.transition = "width 0.1s, opacity 0.4s";
    const duration = 3e3;
    const progress = 1e4 / Math.floor(duration);
    let timeout;
    let interval;
    nuxtApp.hook("page:start", () => {
      if (timeout) {
        return;
      }
      timeout = setTimeout(() => {
        let width = 10;
        el.style.opacity = "100%";
        el.style.width = "10%";
        interval = setInterval(() => {
          if (width >= 100) {
            return;
          }
          width = Math.floor(width + progress);
          el.style.width = `${width}%`;
        }, 100);
      }, 200);
    });
    nuxtApp.hook("page:finish", () => {
      timeout && clearTimeout(timeout);
      timeout = null;
      interval && clearInterval(interval);
      interval = null;
      el.style.width = "100%";
      el.style.opacity = "0%";
      setTimeout(() => {
        el.style.width = "0%";
      }, 500);
    });
  });
});
