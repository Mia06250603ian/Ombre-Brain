// 假 Photon:消息从 globalThis.__photon.inbox 进,发出去的东西记在 space.sent
const ctl = (globalThis.__photon ||= { inbox: [], waiters: [], opened: 0 });
export function push(item) { const w = ctl.waiters.shift(); if (w) w(item); else ctl.inbox.push(item); }
export async function Spectrum() {
  ctl.opened++;
  return {
    messages: { async *[Symbol.asyncIterator]() {
      while (true) { const it = ctl.inbox.length ? ctl.inbox.shift() : await new Promise((r) => ctl.waiters.push(r)); yield it; }
    } },
    async close() {},
  };
}
export const attachment = (input, opts = {}) => ({ type: "attachment", input, ...opts });
export const voice = (input, opts = {}) => ({ type: "voice", size: input.length, ...opts });
export const richlink = (url) => ({ type: "richlink", url });
