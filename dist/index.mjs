import { dirname, resolve, relative, extname, basename, join, parse, normalize, isAbsolute } from 'pathe';
import { createHooks } from 'hookable';
import { resolveFiles, defineNuxtModule, addPlugin, addTemplate, templateUtils, isNuxt3, resolveAlias, addWebpackPlugin, addVitePlugin, addPluginTemplate, useNuxt, nuxtCtx, addComponent, installModule, loadNuxtConfig, normalizeTemplate, compileTemplate, tryResolvePath, normalizePlugin } from '@nuxt/kit';
import { existsSync, statSync, promises } from 'fs';
import { fileURLToPath } from 'url';
import { encodePath, parseURL, parseQuery } from 'ufo';
import { kebabCase, splitByCase, pascalCase, camelCase } from 'scule';
import defu from 'defu';
import globby from 'globby';
import { createUnplugin } from 'unplugin';
import { findExports } from 'mlly';
import { getNitroContext, createDevServer, resolveMiddleware, build as build$1, prepare, generate, wpfs } from '@nuxt/nitro';
import chokidar from 'chokidar';

const distDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(distDir, "..");

async function resolvePagesRoutes(nuxt) {
  const pagesDir = resolve(nuxt.options.srcDir, nuxt.options.dir.pages);
  const files = await resolveFiles(pagesDir, `**/*{${nuxt.options.extensions.join(",")}}`);
  files.sort();
  return generateRoutesFromFiles(files, pagesDir);
}
function generateRoutesFromFiles(files, pagesDir) {
  const routes = [];
  for (const file of files) {
    const segments = relative(pagesDir, file).replace(new RegExp(`${extname(file)}$`), "").split("/");
    const route = {
      name: "",
      path: "",
      file,
      children: []
    };
    let parent = routes;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const tokens = parseSegment(segment);
      const segmentName = tokens.map(({ value }) => value).join("");
      const isSingleSegment = segments.length === 1;
      const isLastSegment = i === segments.length - 1;
      route.name += (route.name && "-") + segmentName;
      const child = parent.find((parentRoute) => parentRoute.name === route.name);
      if (child) {
        parent = child.children;
        route.path = "";
      } else if (segmentName === "404" && isSingleSegment) {
        route.path += "/:catchAll(.*)*";
      } else if (segmentName === "index" && !route.path) {
        route.path += "/";
      } else if (segmentName !== "index") {
        route.path += getRoutePath(tokens);
        if (isLastSegment && tokens.length === 1 && tokens[0].type === 1 /* dynamic */) {
          route.path += "?";
        }
      }
    }
    parent.push(route);
  }
  return prepareRoutes(routes);
}
function getRoutePath(tokens) {
  return tokens.reduce((path, token) => {
    return path + (token.type === 1 /* dynamic */ ? `:${token.value}` : token.type === 2 /* catchall */ ? `:${token.value}(.*)*` : encodePath(token.value));
  }, "/");
}
const PARAM_CHAR_RE = /[\w\d_.]/;
function parseSegment(segment) {
  let state = 0 /* initial */;
  let i = 0;
  let buffer = "";
  const tokens = [];
  function consumeBuffer() {
    if (!buffer) {
      return;
    }
    if (state === 0 /* initial */) {
      throw new Error("wrong state");
    }
    tokens.push({
      type: state === 1 /* static */ ? 0 /* static */ : state === 2 /* dynamic */ ? 1 /* dynamic */ : 2 /* catchall */,
      value: buffer
    });
    buffer = "";
  }
  while (i < segment.length) {
    const c = segment[i];
    switch (state) {
      case 0 /* initial */:
        buffer = "";
        if (c === "[") {
          state = 2 /* dynamic */;
        } else {
          i--;
          state = 1 /* static */;
        }
        break;
      case 1 /* static */:
        if (c === "[") {
          consumeBuffer();
          state = 2 /* dynamic */;
        } else {
          buffer += c;
        }
        break;
      case 3 /* catchall */:
      case 2 /* dynamic */:
        if (buffer === "...") {
          buffer = "";
          state = 3 /* catchall */;
        }
        if (c === "]") {
          if (!buffer) {
            throw new Error("Empty param");
          } else {
            consumeBuffer();
          }
          state = 0 /* initial */;
        } else if (PARAM_CHAR_RE.test(c)) {
          buffer += c;
        } else ;
        break;
    }
    i++;
  }
  if (state === 2 /* dynamic */) {
    throw new Error(`Unfinished param "${buffer}"`);
  }
  consumeBuffer();
  return tokens;
}
function prepareRoutes(routes, parent) {
  for (const route of routes) {
    if (route.name) {
      route.name = route.name.replace(/-index$/, "");
    }
    if (route.path === "/") {
      routes.forEach((siblingRoute) => {
        if (siblingRoute.path.endsWith("?")) {
          siblingRoute.path = siblingRoute.path.slice(0, -1);
        }
      });
    }
    if (parent && route.path.startsWith("/")) {
      route.path = route.path.slice(1);
    }
    if (route.children.length) {
      route.children = prepareRoutes(route.children, route);
    }
    if (route.children.find((childRoute) => childRoute.path === "")) {
      delete route.name;
    }
  }
  return routes;
}
async function resolveLayouts(nuxt) {
  const layoutDir = resolve(nuxt.options.srcDir, nuxt.options.dir.layouts);
  const files = await resolveFiles(layoutDir, `*{${nuxt.options.extensions.join(",")}}`);
  return files.map((file) => {
    const name = kebabCase(basename(file).replace(extname(file), "")).replace(/["']/g, "");
    return { name, file };
  });
}
function addComponentToRoutes(routes) {
  return routes.map((route) => ({
    ...route,
    children: route.children ? addComponentToRoutes(route.children) : [],
    component: `{() => import('${route.file}')}`
  }));
}

const pagesModule = defineNuxtModule({
  name: "router",
  setup(_options, nuxt) {
    const pagesDir = resolve(nuxt.options.srcDir, nuxt.options.dir.pages);
    const runtimeDir = resolve(distDir, "pages/runtime");
    if (!existsSync(pagesDir)) {
      return;
    }
    nuxt.hook("prepare:types", ({ references }) => {
      references.push({ types: "vue-router" });
    });
    nuxt.hook("builder:watch", async (event, path) => {
      const pathPattern = new RegExp(`^(${nuxt.options.dir.pages}|${nuxt.options.dir.layouts})/`);
      if (event !== "change" && path.match(pathPattern)) {
        await nuxt.callHook("builder:generateApp");
      }
    });
    nuxt.hook("app:resolve", (app) => {
      if (app.mainComponent.includes("nuxt-welcome")) {
        app.mainComponent = resolve(runtimeDir, "app.vue");
      }
    });
    addPlugin(resolve(runtimeDir, "router"));
    addTemplate({
      filename: "routes.mjs",
      async getContents() {
        const pages = await resolvePagesRoutes(nuxt);
        await nuxt.callHook("pages:extend", pages);
        const serializedRoutes = addComponentToRoutes(pages);
        return `export default ${templateUtils.serialize(serializedRoutes)}`;
      }
    });
    addTemplate({
      filename: "layouts.mjs",
      async getContents() {
        const layouts = await resolveLayouts(nuxt);
        const layoutsObject = Object.fromEntries(layouts.map(({ name, file }) => {
          return [name, `{defineAsyncComponent({ suspensible: false, loader: () => import('${file}') })}`];
        }));
        return [
          "import { defineAsyncComponent } from 'vue'",
          `export default ${templateUtils.serialize(layoutsObject)}`
        ].join("\n");
      }
    });
  }
});

const metaModule = defineNuxtModule({
  name: "meta",
  defaults: {
    charset: "utf-8",
    viewport: "width=device-width, initial-scale=1"
  },
  setup(options, nuxt) {
    const runtimeDir = nuxt.options.alias["#meta"] || resolve(distDir, "meta/runtime");
    nuxt.options.build.transpile.push("@vueuse/head");
    nuxt.options.alias["#meta"] = runtimeDir;
    const globalMeta = defu(nuxt.options.meta, {
      meta: [
        { charset: options.charset },
        { name: "viewport", content: options.viewport }
      ]
    });
    addTemplate({
      filename: "meta.config.mjs",
      getContents: () => "export default " + JSON.stringify({ globalMeta, mixinKey: isNuxt3() ? "created" : "setup" })
    });
    addPlugin({ src: resolve(runtimeDir, "plugin") });
    addPlugin({ src: resolve(runtimeDir, "lib/vueuse-head.plugin") });
  }
});

const createImportMagicComments = (options) => {
  const { chunkName, prefetch, preload } = options;
  return [
    `webpackChunkName: "${chunkName}"`,
    prefetch === true || typeof prefetch === "number" ? `webpackPrefetch: ${prefetch}` : false,
    preload === true || typeof preload === "number" ? `webpackPreload: ${preload}` : false
  ].filter(Boolean).join(", ");
};
const componentsTemplate = {
  filename: "components.mjs",
  getContents({ options }) {
    return `import { defineAsyncComponent } from 'vue'

const components = {
${options.components.filter((c) => c.global !== false).map((c) => {
      const exp = c.export === "default" ? "c.default || c" : `c['${c.export}']`;
      const magicComments = createImportMagicComments(c);
      return `  '${c.pascalName}': defineAsyncComponent(() => import('${c.filePath}' /* ${magicComments} */).then(c => ${exp}))`;
    }).join(",\n")}
}

export default function (nuxtApp) {
  for (const name in components) {
    nuxtApp.vueApp.component(name, components[name])
    nuxtApp.vueApp.component('Lazy' + name, components[name])
  }
}
`;
  }
};
const componentsTypeTemplate = {
  filename: "components.d.ts",
  write: true,
  getContents: ({ options }) => `// Generated by components discovery
declare module 'vue' {
  export interface GlobalComponents {
${options.components.map((c) => `    '${c.pascalName}': typeof import('${relative(options.buildDir, c.filePath)}')['${c.export}']`).join(",\n")}
  }
}
export {}
`
};

function sortDirsByPathLength({ path: pathA }, { path: pathB }) {
  return pathB.split(/[\\/]/).filter(Boolean).length - pathA.split(/[\\/]/).filter(Boolean).length;
}
function hyphenate(str) {
  return str.replace(/\B([A-Z])/g, "-$1").toLowerCase();
}
async function scanComponents(dirs, srcDir) {
  const components = [];
  const filePaths = /* @__PURE__ */ new Set();
  const scannedPaths = [];
  for (const dir of dirs.sort(sortDirsByPathLength)) {
    const resolvedNames = /* @__PURE__ */ new Map();
    for (const _file of await globby(dir.pattern, { cwd: dir.path, ignore: dir.ignore })) {
      const filePath = join(dir.path, _file);
      if (scannedPaths.find((d) => filePath.startsWith(d))) {
        continue;
      }
      if (filePaths.has(filePath)) {
        continue;
      }
      filePaths.add(filePath);
      const prefixParts = [].concat(dir.prefix ? splitByCase(dir.prefix) : [], dir.pathPrefix !== false ? splitByCase(relative(dir.path, dirname(filePath))) : []);
      let fileName = basename(filePath, extname(filePath));
      if (fileName.toLowerCase() === "index") {
        fileName = dir.pathPrefix === false ? basename(dirname(filePath)) : "";
      }
      const fileNameParts = splitByCase(fileName);
      const componentNameParts = [];
      while (prefixParts.length && (prefixParts[0] || "").toLowerCase() !== (fileNameParts[0] || "").toLowerCase()) {
        componentNameParts.push(prefixParts.shift());
      }
      const componentName = pascalCase(componentNameParts) + pascalCase(fileNameParts);
      if (resolvedNames.has(componentName)) {
        console.warn(`Two component files resolving to the same name \`${componentName}\`:

 - ${filePath}
 - ${resolvedNames.get(componentName)}`);
        continue;
      }
      resolvedNames.set(componentName, filePath);
      const pascalName = pascalCase(componentName).replace(/["']/g, "");
      const kebabName = hyphenate(componentName);
      const shortPath = relative(srcDir, filePath);
      const chunkName = "components/" + kebabName;
      let component = {
        filePath,
        pascalName,
        kebabName,
        chunkName,
        shortPath,
        export: "default",
        global: dir.global,
        level: Number(dir.level),
        prefetch: Boolean(dir.prefetch),
        preload: Boolean(dir.preload)
      };
      if (typeof dir.extendComponent === "function") {
        component = await dir.extendComponent(component) || component;
      }
      const definedComponent = components.find((c) => c.pascalName === component.pascalName);
      if (definedComponent && component.level < definedComponent.level) {
        Object.assign(definedComponent, component);
      } else if (!definedComponent) {
        components.push(component);
      }
    }
    scannedPaths.push(dir.path);
  }
  return components;
}

const loaderPlugin = createUnplugin((options) => ({
  name: "nuxt-components-loader",
  enforce: "post",
  transformInclude(id) {
    const { pathname, search } = parseURL(id);
    const query = parseQuery(search);
    return pathname.endsWith(".vue") && (query.type === "template" || !search);
  },
  transform(code) {
    return transform(code, options.getComponents());
  }
}));
function findComponent(components, name) {
  return components.find(({ pascalName, kebabName }) => [pascalName, kebabName].includes(name));
}
function transform(content, components) {
  let num = 0;
  let imports = "";
  const map = /* @__PURE__ */ new Map();
  const newContent = content.replace(/ _resolveComponent\("(.*?)"\)/g, (full, name) => {
    const component = findComponent(components, name);
    if (component) {
      const identifier = map.get(component) || `__nuxt_component_${num++}`;
      map.set(component, identifier);
      imports += `import ${identifier} from "${component.filePath}";`;
      return ` ${identifier}`;
    }
    return full;
  });
  return `${imports}
${newContent}`;
}

const isPureObjectOrString = (val) => !Array.isArray(val) && typeof val === "object" || typeof val === "string";
const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch (_e) {
    return false;
  }
};
const componentsModule = defineNuxtModule({
  name: "components",
  configKey: "components",
  defaults: {
    dirs: ["~/components"]
  },
  setup(options, nuxt) {
    let componentDirs = [];
    let components = [];
    nuxt.hook("app:resolve", async () => {
      await nuxt.callHook("components:dirs", options.dirs);
      componentDirs = options.dirs.filter(isPureObjectOrString).map((dir) => {
        const dirOptions = typeof dir === "object" ? dir : { path: dir };
        const dirPath = resolveAlias(dirOptions.path, nuxt.options.alias);
        const transpile = typeof dirOptions.transpile === "boolean" ? dirOptions.transpile : "auto";
        const extensions = (dirOptions.extensions || nuxt.options.extensions).map((e) => e.replace(/^\./g, ""));
        dirOptions.level = Number(dirOptions.level || 0);
        const present = isDirectory(dirPath);
        if (!present && dirOptions.path !== "~/components") {
          console.warn("Components directory not found: `" + dirPath + "`");
        }
        return {
          ...dirOptions,
          enabled: true,
          path: dirPath,
          extensions,
          pattern: dirOptions.pattern || `**/*.{${extensions.join(",")},}`,
          ignore: [
            "**/*.stories.{js,ts,jsx,tsx}",
            "**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}",
            "**/*.d.ts",
            ...dirOptions.ignore || []
          ],
          transpile: transpile === "auto" ? dirPath.includes("node_modules") : transpile
        };
      }).filter((d) => d.enabled);
      nuxt.options.build.transpile.push(...componentDirs.filter((dir) => dir.transpile).map((dir) => dir.path));
    });
    nuxt.hook("app:templates", async (app) => {
      components = await scanComponents(componentDirs, nuxt.options.srcDir);
      await nuxt.callHook("components:extend", components);
      if (!components.length) {
        return;
      }
      app.templates.push({
        ...componentsTemplate,
        options: { components }
      });
      app.templates.push({
        ...componentsTypeTemplate,
        options: { components, buildDir: nuxt.options.buildDir }
      });
      app.plugins.push({ src: "#build/components" });
    });
    nuxt.hook("prepare:types", ({ references }) => {
      if (components.length) {
        references.push({ path: resolve(nuxt.options.buildDir, "components.d.ts") });
      }
    });
    nuxt.hook("builder:watch", async (event, path) => {
      if (!["add", "unlink"].includes(event)) {
        return;
      }
      const fPath = resolve(nuxt.options.rootDir, path);
      if (componentDirs.find((dir) => fPath.startsWith(dir.path))) {
        await nuxt.callHook("builder:generateApp");
      }
    });
    const loaderOptions = { getComponents: () => components };
    addWebpackPlugin(loaderPlugin.webpack(loaderOptions));
    addVitePlugin(loaderPlugin.vite(loaderOptions));
  }
});

function toImportModuleMap(autoImports, isCJS = false) {
  const aliasKeyword = isCJS ? " : " : " as ";
  const map = {};
  for (const autoImport of autoImports) {
    if (!map[autoImport.from]) {
      map[autoImport.from] = /* @__PURE__ */ new Set();
    }
    map[autoImport.from].add(autoImport.name === autoImport.as ? autoImport.name : autoImport.name + aliasKeyword + autoImport.as);
  }
  return map;
}
function toImports(autoImports, isCJS = false) {
  const map = toImportModuleMap(autoImports, isCJS);
  if (isCJS) {
    return Object.entries(map).map(([name, imports]) => `const { ${Array.from(imports).join(", ")} } = require('${name}');`).join("\n");
  } else {
    return Object.entries(map).map(([name, imports]) => `import { ${Array.from(imports).join(", ")} } from '${name}';`).join("\n");
  }
}
function toExports(autoImports) {
  const map = toImportModuleMap(autoImports, false);
  return Object.entries(map).map(([name, imports]) => `export { ${Array.from(imports).join(", ")} } from '${name}';`).join("\n");
}
function filterInPlace(arr, predicate) {
  let i = arr.length;
  while (i--) {
    if (!predicate(arr[i])) {
      arr.splice(i, 1);
    }
  }
}

const excludeRE = [
  /\bimport\s*([\s\S]+?)\s*from\b/g,
  /\bfunction\s*([\w_$]+?)\s*\(/g,
  /\b(?:const|let|var)\s+?(\[[\s\S]*?\]|\{[\s\S]*?\}|[\s\S]+?)\s*?[=;\n]/g
];
const importAsRE = /^.*\sas\s+/;
const seperatorRE = /[,[\]{}\n]/g;
const multilineCommentsRE = /\/\*\s(.|[\r\n])*?\*\//gm;
const singlelineCommentsRE = /\/\/\s.*/g;
const templateLiteralRE = /\$\{(.*)\}/g;
const quotesRE = [
  /(["'])((?:\\\1|(?!\1)|.|\r)*?)\1/gm,
  /([`])((?:\\\1|(?!\1)|.|\n|\r)*?)\1/gm
];
function stripeCommentsAndStrings(code) {
  return code.replace(multilineCommentsRE, "").replace(singlelineCommentsRE, "").replace(templateLiteralRE, "` + $1 + `").replace(quotesRE[0], '""').replace(quotesRE[1], "``");
}
const TransformPlugin = createUnplugin((ctx) => {
  return {
    name: "nuxt-auto-imports-transform",
    enforce: "post",
    transformInclude(id) {
      const { pathname, search } = parseURL(id);
      const { type } = parseQuery(search);
      if (id.includes("node_modules")) {
        return false;
      }
      if (pathname.endsWith(".vue") && (type === "template" || type === "script" || !search)) {
        return true;
      }
      if (pathname.match(/\.((c|m)?j|t)sx?$/g)) {
        return true;
      }
    },
    transform(code) {
      const striped = stripeCommentsAndStrings(code);
      const matched = new Set(Array.from(striped.matchAll(ctx.matchRE)).map((i) => i[1]));
      for (const regex of excludeRE) {
        Array.from(striped.matchAll(regex)).flatMap((i) => [
          ...i[1]?.split(seperatorRE) || [],
          ...i[2]?.split(seperatorRE) || []
        ]).map((i) => i.replace(importAsRE, "").trim()).forEach((i) => matched.delete(i));
      }
      if (!matched.size) {
        return null;
      }
      const isCJSContext = code.includes("require(");
      const matchedImports = Array.from(matched).map((name) => ctx.map.get(name)).filter(Boolean);
      const imports = toImports(matchedImports, isCJSContext);
      return imports + code;
    }
  };
});

const Nuxt3AutoImports = [
  {
    from: "#app",
    names: [
      "useAsyncData",
      "useLazyAsyncData",
      "defineNuxtComponent",
      "useNuxtApp",
      "defineNuxtPlugin",
      "useRuntimeConfig",
      "useState",
      "useFetch",
      "useLazyFetch",
      "useCookie"
    ]
  },
  {
    from: "#meta",
    names: [
      "useMeta"
    ]
  },
  {
    from: "vue-router",
    names: [
      "useRoute",
      "useRouter"
    ]
  },
  {
    from: "vue-demi",
    names: [
      "isVue2",
      "isVue3"
    ]
  },
  {
    from: "vue",
    names: [
      "defineEmits",
      "defineExpose",
      "defineProps",
      "withCtx",
      "withDefaults",
      "withDirectives",
      "withKeys",
      "withMemo",
      "withModifiers",
      "withScopeId",
      "onActivated",
      "onBeforeMount",
      "onBeforeUnmount",
      "onBeforeUpdate",
      "onDeactivated",
      "onErrorCaptured",
      "onMounted",
      "onRenderTracked",
      "onRenderTriggered",
      "onServerPrefetch",
      "onUnmounted",
      "onUpdated",
      "computed",
      "customRef",
      "isProxy",
      "isReactive",
      "isReadonly",
      "isRef",
      "markRaw",
      "proxyRefs",
      "reactive",
      "readonly",
      "ref",
      "shallowReactive",
      "shallowReadonly",
      "shallowRef",
      "stop",
      "toRaw",
      "toRef",
      "toRefs",
      "triggerRef",
      "unref",
      "watch",
      "watchEffect",
      "effect",
      "effectScope",
      "getCurrentScope",
      "onScopeDispose",
      "defineComponent",
      "defineAsyncComponent",
      "getCurrentInstance",
      "h",
      "inject",
      "nextTick",
      "provide",
      "useAttrs",
      "useCssModule",
      "useCssVars",
      "useSlots",
      "useTransitionState"
    ]
  }
];

async function scanForComposables(dir, autoImports) {
  if (!existsSync(dir)) {
    return;
  }
  const files = await globby(["*.{ts,js,tsx,jsx,mjs,cjs,mts,cts}"], { cwd: dir });
  await Promise.all(files.map(async (file) => {
    const importPath = join(dir, file);
    filterInPlace(autoImports, (i) => i.from !== importPath);
    const code = await promises.readFile(join(dir, file), "utf-8");
    const exports = findExports(code);
    const defaultExport = exports.find((i) => i.type === "default");
    if (defaultExport) {
      autoImports.push({ name: "default", as: camelCase(parse(file).name), from: importPath });
    }
    for (const exp of exports) {
      if (exp.type === "named") {
        for (const name of exp.names) {
          autoImports.push({ name, as: name, from: importPath });
        }
      } else if (exp.type === "declaration") {
        autoImports.push({ name: exp.name, as: exp.name, from: importPath });
      }
    }
  }));
}

function createAutoImportContext() {
  return {
    autoImports: [],
    map: /* @__PURE__ */ new Map(),
    matchRE: /__never__/
  };
}
function updateAutoImportContext(ctx) {
  const usedNames = /* @__PURE__ */ new Set();
  for (const autoImport of ctx.autoImports) {
    if (usedNames.has(autoImport.as)) {
      autoImport.disabled = true;
      console.warn(`Disabling duplicate auto import '${autoImport.as}' (imported from '${autoImport.from}')`);
    } else {
      usedNames.add(autoImport.as);
    }
  }
  ctx.autoImports = ctx.autoImports.filter((i) => i.disabled !== true);
  ctx.matchRE = new RegExp(`\\b(${ctx.autoImports.map((i) => i.as).join("|")})\\b`, "g");
  ctx.map.clear();
  for (const autoImport of ctx.autoImports) {
    ctx.map.set(autoImport.as, autoImport);
  }
  return ctx;
}

const autoImportsModule = defineNuxtModule({
  name: "auto-imports",
  configKey: "autoImports",
  defaults: {
    sources: Nuxt3AutoImports,
    global: false,
    dirs: []
  },
  async setup(options, nuxt) {
    await nuxt.callHook("autoImports:sources", options.sources);
    options.sources = options.sources.filter((source) => source.disabled !== true);
    const ctx = createAutoImportContext();
    for (const source of options.sources) {
      for (const importName of source.names) {
        if (typeof importName === "string") {
          ctx.autoImports.push({ name: importName, as: importName, from: source.from });
        } else {
          ctx.autoImports.push({ name: importName.name, as: importName.as || importName.name, from: source.from });
        }
      }
    }
    let composablesDirs = [
      join(nuxt.options.srcDir, "composables"),
      ...options.dirs
    ];
    await nuxt.callHook("autoImports:dirs", composablesDirs);
    composablesDirs = composablesDirs.map((dir) => normalize(dir));
    addTemplate({
      filename: "imports.mjs",
      getContents: () => toExports(ctx.autoImports)
    });
    nuxt.options.alias["#imports"] = join(nuxt.options.buildDir, "imports");
    if (nuxt.options.dev && options.global) {
      addPluginTemplate({
        filename: "auto-imports.mjs",
        src: "",
        getContents: () => {
          const imports = toImports(ctx.autoImports);
          const globalThisSet = ctx.autoImports.map((i) => `globalThis.${i.as} = ${i.as};`).join("\n");
          return `${imports}

${globalThisSet}

export default () => {};`;
        }
      });
    } else {
      addVitePlugin(TransformPlugin.vite(ctx));
      addWebpackPlugin(TransformPlugin.webpack(ctx));
    }
    const updateAutoImports = async () => {
      for (const composablesDir of composablesDirs) {
        await scanForComposables(composablesDir, ctx.autoImports);
      }
      await nuxt.callHook("autoImports:extend", ctx.autoImports);
      updateAutoImportContext(ctx);
      generateDts(ctx);
    };
    await updateAutoImports();
    nuxt.hook("prepare:types", ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, "auto-imports.d.ts") });
    });
    nuxt.hook("builder:watch", async (_, path) => {
      const _resolved = resolve(nuxt.options.srcDir, path);
      if (composablesDirs.find((dir) => _resolved.startsWith(dir))) {
        await updateAutoImports();
      }
    });
  }
});
function generateDts(ctx) {
  const nuxt = useNuxt();
  const resolved = {};
  const r = (id) => {
    if (resolved[id]) {
      return resolved[id];
    }
    let path = resolveAlias(id, nuxt.options.alias);
    if (isAbsolute(path)) {
      path = relative(nuxt.options.buildDir, path);
    }
    path = path.replace(/\.[a-z]+$/, "");
    resolved[id] = path;
    return path;
  };
  addTemplate({
    filename: "imports.d.ts",
    write: true,
    getContents: () => toExports(ctx.autoImports)
  });
  addTemplate({
    filename: "auto-imports.d.ts",
    write: true,
    getContents: () => `// Generated by auto imports
declare global {
${ctx.autoImports.map((i) => `  const ${i.as}: typeof import('${r(i.from)}')['${i.name}']`).join("\n")}
}

export {}
`
  });
}

const version = "3.0.0";

function initNitro(nuxt) {
  const nitroOptions = nuxt.options.nitro || {};
  const nitroContext = getNitroContext(nuxt.options, nitroOptions);
  const nitroDevContext = getNitroContext(nuxt.options, { ...nitroOptions, preset: "dev" });
  nuxt.server = createDevServer(nitroDevContext);
  if (nuxt.vfs) {
    nitroContext.vfs = nuxt.vfs;
    nitroDevContext.vfs = nuxt.vfs;
  }
  nuxt.hooks.addHooks(nitroContext.nuxtHooks);
  nuxt.hook("close", () => nitroContext._internal.hooks.callHook("close"));
  nitroContext._internal.hooks.hook("nitro:document", (template) => nuxt.callHook("nitro:document", template));
  nuxt.hooks.addHooks(nitroDevContext.nuxtHooks);
  nuxt.hook("close", () => nitroDevContext._internal.hooks.callHook("close"));
  nitroDevContext._internal.hooks.hook("nitro:document", (template) => nuxt.callHook("nitro:document", template));
  nuxt.hook("prepare:types", (opts) => {
    opts.references.push({ path: resolve(nuxt.options.buildDir, "nitro.d.ts") });
  });
  nuxt.hook("app:resolve", (app) => {
    app.plugins.push({ src: resolve(nitroContext._internal.runtimeDir, "app/nitro.client.mjs") });
  });
  nuxt.options.env.NITRO_PRESET = nitroContext.preset;
  nuxt.hook("modules:done", async () => {
    await nuxt.callHook("nitro:context", nitroContext);
    await nuxt.callHook("nitro:context", nitroDevContext);
    const { middleware, legacyMiddleware } = resolveMiddleware(nuxt);
    nuxt.server.setLegacyMiddleware(legacyMiddleware);
    nitroContext.middleware.push(...middleware);
    nitroDevContext.middleware.push(...middleware);
  });
  nuxt.hook("build:done", async () => {
    if (nuxt.options.dev) {
      await build$1(nitroDevContext);
    } else if (!nitroContext._nuxt.isStatic) {
      await prepare(nitroContext);
      await generate(nitroContext);
      await build$1(nitroContext);
    }
  });
  if (nuxt.options.dev) {
    nitroDevContext._internal.hooks.hook("nitro:compiled", () => {
      nuxt.server.watch();
    });
    nuxt.hook("build:compile", ({ compiler }) => {
      compiler.outputFileSystem = wpfs;
    });
    nuxt.hook("server:devMiddleware", (m) => {
      nuxt.server.setDevMiddleware(m);
    });
  }
}

const addModuleTranspiles = () => {
  const nuxt = useNuxt();
  const modules = [
    ...nuxt.options.buildModules,
    ...nuxt.options.modules,
    ...nuxt.options._modules
  ].map((m) => typeof m === "string" ? m : Array.isArray(m) ? m[0] : m.src).filter((m) => typeof m === "string").map((m) => m.split("node_modules/").pop());
  nuxt.options.build.transpile = nuxt.options.build.transpile.map((m) => typeof m === "string" ? m.split("node_modules/").pop() : m);
  function isTranspilePresent(mod) {
    return nuxt.options.build.transpile.some((t) => !(t instanceof Function) && (t instanceof RegExp ? t.test(mod) : new RegExp(t).test(mod)));
  }
  for (const module of modules) {
    if (!isTranspilePresent(module)) {
      nuxt.options.build.transpile.push(module);
    }
  }
};

function createNuxt(options) {
  const hooks = createHooks();
  const nuxt = {
    _version: version,
    options,
    hooks,
    callHook: hooks.callHook,
    addHooks: hooks.addHooks,
    hook: hooks.hook,
    ready: () => initNuxt(nuxt),
    close: () => Promise.resolve(hooks.callHook("close", nuxt)),
    vfs: {}
  };
  return nuxt;
}
async function initNuxt(nuxt) {
  nuxt.hooks.addHooks(nuxt.options.hooks);
  nuxtCtx.set(nuxt);
  nuxt.hook("close", () => nuxtCtx.unset());
  await initNitro(nuxt);
  nuxt.hook("prepare:types", (opts) => {
    opts.references.push({ types: "nuxt3" });
    opts.references.push({ path: resolve(nuxt.options.buildDir, "plugins.d.ts") });
  });
  await nuxt.callHook("modules:before", { nuxt });
  const modulesToInstall = [
    ...nuxt.options.buildModules,
    ...nuxt.options.modules,
    ...nuxt.options._modules
  ];
  addComponent({
    name: "NuxtWelcome",
    filePath: resolve(nuxt.options.appDir, "components/nuxt-welcome.vue")
  });
  addComponent({
    name: "ClientOnly",
    filePath: resolve(nuxt.options.appDir, "components/client-only")
  });
  for (const m of modulesToInstall) {
    await installModule(nuxt, m);
  }
  await nuxt.callHook("modules:done", { nuxt });
  await addModuleTranspiles();
  await nuxt.callHook("ready", nuxt);
}
async function loadNuxt(opts) {
  const options = await loadNuxtConfig(opts);
  options.appDir = options.alias["#app"] = resolve(distDir, "app");
  options._majorVersion = 3;
  options.buildModules.push(pagesModule, metaModule, componentsModule, autoImportsModule);
  options.modulesDir.push(resolve(pkgDir, "node_modules"));
  options.alias["vue-demi"] = resolve(options.appDir, "compat/vue-demi");
  options.alias["@vue/composition-api"] = resolve(options.appDir, "compat/capi");
  const nuxt = createNuxt(options);
  if (opts.ready !== false) {
    await nuxt.ready();
  }
  return nuxt;
}
function defineNuxtConfig(config) {
  return config;
}

const appComponentTemplate = {
  filename: "app-component.mjs",
  getContents(ctx) {
    return `export { default } from '${ctx.app.mainComponent}'`;
  }
};
const rootComponentTemplate = {
  filename: "root-component.mjs",
  getContents(ctx) {
    return `export { default } from '${ctx.app.rootComponent}'`;
  }
};
const cssTemplate = {
  filename: "css.mjs",
  getContents(ctx) {
    return ctx.nuxt.options.css.map((i) => `import '${i.src || i}';`).join("\n");
  }
};
const clientPluginTemplate = {
  filename: "plugins/client.mjs",
  getContents(ctx) {
    const clientPlugins = ctx.app.plugins.filter((p) => !p.mode || p.mode !== "server");
    return [
      templateUtils.importSources(clientPlugins.map((p) => p.src)),
      "export default [",
      clientPlugins.map((p) => templateUtils.importName(p.src)).join(",\n  "),
      "]"
    ].join("\n");
  }
};
const serverPluginTemplate = {
  filename: "plugins/server.mjs",
  getContents(ctx) {
    const serverPlugins = ctx.app.plugins.filter((p) => !p.mode || p.mode !== "client");
    return [
      "import preload from '#app/plugins/preload.server'",
      templateUtils.importSources(serverPlugins.map((p) => p.src)),
      "export default [",
      "  preload,",
      serverPlugins.map((p) => templateUtils.importName(p.src)).join(",\n  "),
      "]"
    ].join("\n");
  }
};
const appViewTemplate = {
  filename: "views/app.template.html",
  getContents() {
    return `<!DOCTYPE html>
<html {{ HTML_ATTRS }}>

<head {{ HEAD_ATTRS }}>
  {{ HEAD }}
</head>

<body {{ BODY_ATTRS }}>
  {{ APP }}
</body>

</html>
`;
  }
};
const pluginsDeclaration = {
  filename: "plugins.d.ts",
  write: true,
  getContents: (ctx) => {
    const EXTENSION_RE = new RegExp(`(?<=\\w)(${ctx.nuxt.options.extensions.map((e) => `\\${e}`).join("|")})$`, "g");
    const tsImports = ctx.app.plugins.map((p) => relative(ctx.nuxt.options.buildDir, p.src).replace(EXTENSION_RE, ""));
    return `// Generated by Nuxt3'
import type { Plugin } from '#app'

type Decorate<T extends Record<string, any>> = { [K in keyof T as K extends string ? \`$\${K}\` : never]: T[K] }

type InjectionType<A extends Plugin> = A extends Plugin<infer T> ? Decorate<T> : unknown

type NuxtAppInjections = 
  ${tsImports.map((p) => `InjectionType<typeof import('${p}').default>`).join(" &\n  ")}

declare module '#app' {
  interface NuxtApp extends NuxtAppInjections { }
}

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties extends NuxtAppInjections { }
}

export { }
`;
  }
};

const defaultTemplates = {
  __proto__: null,
  appComponentTemplate: appComponentTemplate,
  rootComponentTemplate: rootComponentTemplate,
  cssTemplate: cssTemplate,
  clientPluginTemplate: clientPluginTemplate,
  serverPluginTemplate: serverPluginTemplate,
  appViewTemplate: appViewTemplate,
  pluginsDeclaration: pluginsDeclaration
};

function createApp(nuxt, options = {}) {
  return defu(options, {
    dir: nuxt.options.srcDir,
    extensions: nuxt.options.extensions,
    plugins: [],
    templates: []
  });
}
async function generateApp(nuxt, app) {
  await resolveApp(nuxt, app);
  app.templates = Object.values(defaultTemplates).concat(nuxt.options.build.templates);
  await nuxt.callHook("app:templates", app);
  app.templates = app.templates.map((tmpl) => normalizeTemplate(tmpl));
  const templateContext = { utils: templateUtils, nuxt, app };
  await Promise.all(app.templates.map(async (template) => {
    const contents = await compileTemplate(template, templateContext);
    const fullPath = template.dst || resolve(nuxt.options.buildDir, template.filename);
    nuxt.vfs[fullPath] = contents;
    const aliasPath = "#build/" + template.filename.replace(/\.\w+$/, "");
    nuxt.vfs[aliasPath] = contents;
    if (process.platform === "win32") {
      nuxt.vfs[fullPath.replace(/\//g, "\\")] = contents;
    }
    if (template.write) {
      await promises.writeFile(fullPath, contents, "utf8");
    }
  }));
  await nuxt.callHook("app:templatesGenerated", app);
}
async function resolveApp(nuxt, app) {
  const resolveOptions = {
    base: nuxt.options.srcDir,
    alias: nuxt.options.alias,
    extensions: nuxt.options.extensions
  };
  if (!app.mainComponent) {
    app.mainComponent = tryResolvePath("~/App", resolveOptions) || tryResolvePath("~/app", resolveOptions);
  }
  if (!app.mainComponent) {
    app.mainComponent = resolve(nuxt.options.appDir, "components/nuxt-welcome.vue");
  }
  app.rootComponent = resolve(nuxt.options.appDir, "components/nuxt-root.vue");
  app.plugins = [
    ...nuxt.options.plugins,
    ...await resolveFiles(nuxt.options.srcDir, "plugins/**/*.{js,ts,mjs,cjs}")
  ].map((plugin) => normalizePlugin(plugin));
  await nuxt.callHook("app:resolve", app);
}

async function build(nuxt) {
  const app = createApp(nuxt);
  await generateApp(nuxt, app);
  if (nuxt.options.dev) {
    watch(nuxt);
    nuxt.hook("builder:watch", async (event, path) => {
      if (event !== "change" && /app|plugins/i.test(path)) {
        if (path.match(/app/i)) {
          app.mainComponent = null;
        }
        await generateApp(nuxt, app);
      }
    });
    nuxt.hook("builder:generateApp", () => generateApp(nuxt, app));
  }
  await nuxt.callHook("build:before", { nuxt }, nuxt.options.build);
  await bundle(nuxt);
  await nuxt.callHook("build:done", { nuxt });
  if (!nuxt.options.dev) {
    await nuxt.callHook("close", nuxt);
  }
}
function watch(nuxt) {
  const watcher = chokidar.watch(nuxt.options.srcDir, {
    ...nuxt.options.watchers.chokidar,
    cwd: nuxt.options.srcDir,
    ignoreInitial: true,
    ignored: [
      ".nuxt",
      ".output",
      "node_modules"
    ]
  });
  const watchHook = (event, path) => nuxt.callHook("builder:watch", event, path);
  watcher.on("all", watchHook);
  nuxt.hook("close", () => watcher.close());
  return watcher;
}
async function bundle(nuxt) {
  const useVite = nuxt.options.vite !== false;
  const { bundle: bundle2 } = await (useVite ? import('@nuxt/vite-builder') : import('@nuxt/webpack-builder'));
  try {
    return bundle2(nuxt);
  } catch (error) {
    await nuxt.callHook("build:error", error);
    throw error;
  }
}

export { build, createNuxt, defineNuxtConfig, loadNuxt };
