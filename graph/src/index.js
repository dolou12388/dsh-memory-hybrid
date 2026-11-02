/**
 * dsh-memory-graph —— 宿主半。
 *
 * 这一半刻意是空的：所有数据都来自 `dsh-memory-hybrid` 的 Connection RPC
 * 通道（`/memory-hybrid` → endpoint `graph`），浏览器半自己取。
 *
 * 为什么不在这里代转一次：
 *   · 代转需要在宿主半注入一个 Cordis Service，等于给核心再加一个跨包契约；
 *   · RPC 通道本来就是 wire-level 约定，浏览器半直接调它，链路更短、少一层错误面。
 *
 * 代价是：核心没装或版本过旧时，面板要能说清楚「取不到数据是因为谁」。
 * 这由浏览器半的 404 分支负责。
 */

export const name = "dsh-memory-graph";

export const inject = [];

export function apply(ctx) {
  // 存在的意义就是让包被加载，从而让 package.json 里 dsh.client 指向的
  // 浏览器半进入启动图。没有可注册的东西，因此这里也不读任何 ctx 属性。
  //
  // ⚠ 不要在这里写 ctx.logger：Cordis 的属性访问有 inject 保护，
  // 未在 inject 里声明的服务，读一下就会抛
  // `cannot get property "logger" without inject`，
  // 而宿主 half 一旦 apply 抛错，整个包会被判定为 failed，
  // 浏览器半也就跟着不加载了（面板直接消失）。
  void ctx;
}
