// 演练用:把 spectrum-ts / @spectrum-ts/imessage 换成本目录的假货(module.register 的 resolve 钩子)
export async function resolve(specifier, context, next) {
  if (specifier === "spectrum-ts") return { url: new URL("./fake-spectrum.mjs", import.meta.url).href, shortCircuit: true };
  if (specifier === "@spectrum-ts/imessage") return { url: new URL("./fake-imessage.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
