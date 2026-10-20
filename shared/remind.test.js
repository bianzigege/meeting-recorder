// 提醒调度的测试:用假时间模拟服务定时检查(默认每 10 分钟,step 可改)。运行:bun test
import { test, expect } from "bun:test";
import { remindMinutes, formatRemindTimes, parseRemindTimes, remindOpts, remindSlotToSend, remindPlanText } from "./core.js";

// 时间表写成「9:00, 21:00」好比对
const times = (opts) => formatRemindTimes(remindMinutes(opts));

// 从 start 开始每 step 分钟检查一次,跑 hours 小时,返回发提醒的时刻(HH:MM)。state 像 reminders.json 一样跨检查保留
function simulate(start, opts, { hours = 24, state = {}, step = 10 } = {}) {
  const sent = [];
  for (let t = start.getTime(); t < start.getTime() + hours * 3600_000; t += step * 60_000) {
    const now = new Date(t);
    const slot = remindSlotToSend(now, opts, state);
    if (!slot) continue;
    state.lastSlot = slot.key;
    sent.push(`${now.getDate()}日 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  }
  return { sent, state };
}
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);

test("每天一次:一天只在 9 点发一次", () => {
  expect(simulate(at(18, 0, 3), { hour: "9", frequency: "daily" }).sent).toEqual(["18日 09:03"]);
});

test("每半天一次:一天正好发两次,9 点和 21 点", () => {
  expect(simulate(at(18, 0, 3), { hour: "9", frequency: "halfday" }).sent).toEqual(["18日 09:03", "18日 21:03"]);
});

test("每半天一次连跑两天:四次,不重复", () => {
  expect(simulate(at(18, 0, 7), { hour: "9", frequency: "halfday" }, { hours: 48 }).sent)
    .toEqual(["18日 09:07", "18日 21:07", "19日 09:07", "19日 21:07"]);
});

test("下午的时间设成每半天:15 点和凌晨 3 点", () => {
  expect(times({ hour: "15", frequency: "halfday" })).toBe("3:00, 15:00");
  expect(simulate(at(18, 0, 0), { hour: "15", frequency: "halfday" }).sent).toEqual(["18日 03:00", "18日 15:00"]);
});

test("老配置没有频率字段:按每天一次", () => {
  expect(times({ hour: "9" })).toBe("9:00");
  expect(simulate(at(18, 0, 3), { hour: "9" }).sent).toEqual(["18日 09:03"]);
});

test("老的去重记录(只有日期):当天不再重发,第二天照常", () => {
  const { sent } = simulate(at(18, 9, 30), { hour: "9", frequency: "daily" }, { hours: 24, state: { lastDailyRun: "2026-10-18" } });
  expect(sent).toEqual(["19日 09:00"]);
});

test("老记录 + 当天改成每半天:晚上那次照发", () => {
  const { sent } = simulate(at(18, 9, 30), { hour: "9", frequency: "halfday" }, { hours: 14, state: { lastDailyRun: "2026-10-18" } });
  expect(sent).toEqual(["18日 21:00"]);
});

test("电脑睡过两个时段:醒来只补最近的一条", () => {
  const { sent } = simulate(at(18, 22, 0), { hour: "9", frequency: "halfday" }, { hours: 1, state: { lastSlot: "2026-10-17#1" } });
  expect(sent).toEqual(["18日 22:00"]);
});

test("当天发过晚上那次后把时间改早:不会把上午时段再发一遍", () => {
  const state = { lastSlot: "2026-10-18#1" };
  expect(remindSlotToSend(at(18, 22), { hour: "11", frequency: "halfday" }, state)).toBeNull();
});

test("固定演示日期时按演示日期去重", () => {
  const opts = { hour: "9", frequency: "daily" };
  expect(remindSlotToSend(at(18, 10), opts, {}, "2026-10-27")?.key).toBe("2026-10-27 09:00");
  expect(remindSlotToSend(at(18, 10), opts, { lastSlot: "2026-10-27 09:00" }, "2026-10-27")).toBeNull();
  expect(remindSlotToSend(at(18, 10), opts, { lastSlot: "2026-10-27#0" }, "2026-10-27")).toBeNull();
});

test("0 点就是 0 点,乱填按 9 点", () => {
  expect(times({ hour: "0", frequency: "halfday" })).toBe("0:00, 12:00");
  expect(times({ hour: "", frequency: "daily" })).toBe("9:00");
  expect(times({ hour: "30", frequency: "daily" })).toBe("23:00");
});

test("预览文案写清下一次", () => {
  expect(remindPlanText(at(18, 8), { hour: "9", frequency: "daily" })).toBe("每天 9:00 提醒一次，下一次：今天 9:00。");
  expect(remindPlanText(at(18, 10), { hour: "9", frequency: "daily" })).toBe("每天 9:00 提醒一次，下一次：明天 9:00。");
  expect(remindPlanText(at(18, 10), { hour: "9", frequency: "halfday" })).toBe("每天 9:00 和 21:00 各提醒一次，下一次：今天 21:00。");
  expect(remindPlanText(at(18, 22), { hour: "9", frequency: "halfday" })).toBe("每天 9:00 和 21:00 各提醒一次，下一次：明天 9:00。");
});

// ---------- 每隔几小时 ----------
test("每隔 3 小时:从 9 点到 21 点,一天 5 次,夜里不发", () => {
  expect(times({ hour: "9", frequency: "hours", every: "3" })).toBe("9:00, 12:00, 15:00, 18:00, 21:00");
  expect(simulate(at(18, 0, 0), { hour: "9", frequency: "hours", every: "3" }, { hours: 48, step: 1 }).sent)
    .toEqual(["18日 09:00", "18日 12:00", "18日 15:00", "18日 18:00", "18日 21:00", "19日 09:00", "19日 12:00", "19日 15:00", "19日 18:00", "19日 21:00"]);
});

test("每隔 1 小时从 0 点起:一天 24 次,过了 10 点也照样按顺序发", () => {
  const opts = { hour: "0", frequency: "hours", every: "1" };
  expect(remindMinutes(opts)).toHaveLength(24);
  const { sent } = simulate(at(18, 0, 0), opts, { step: 1 });
  expect(sent).toHaveLength(24);
  expect(sent.slice(9, 12)).toEqual(["18日 09:00", "18日 10:00", "18日 11:00"]);
});

test("每隔几小时乱填:没填按 3,超出按 1–12", () => {
  expect(times({ hour: "9", frequency: "hours", every: "" })).toBe(times({ hour: "9", frequency: "hours", every: "3" }));
  expect(times({ hour: "9", frequency: "hours", every: "0" })).toHaveLength(times({ hour: "9", frequency: "hours", every: "1" }).length);
  expect(times({ hour: "9", frequency: "hours", every: "99" })).toBe("9:00, 21:00");
  expect(times({ hour: "23", frequency: "hours", every: "3" })).toBe("23:00");
});

// ---------- 自己定时间点 ----------
test("时间点各种写法都认,去重排序", () => {
  expect(formatRemindTimes(parseRemindTimes("18:00, 9:00，14:30、9点"))).toBe("9:00, 14:30, 18:00");
  expect(formatRemindTimes(parseRemindTimes("9点 12点半 17：45 20"))).toBe("9:00, 12:30, 17:45, 20:00");
  expect(parseRemindTimes("25:00, 9:75, 随便写")).toEqual([]);
});

test("自己定时间点:到分钟发,每个时间点一次", () => {
  const opts = { hour: "9", frequency: "custom", times: "9:00, 14:30, 18:00" };
  expect(simulate(at(18, 0, 0), opts, { step: 1 }).sent).toEqual(["18日 09:00", "18日 14:30", "18日 18:00"]);
  expect(simulate(at(18, 0, 3), opts).sent).toEqual(["18日 09:03", "18日 14:33", "18日 18:03"]);
});

test("自己定时间点一个都没认出:按提醒时间每天一次", () => {
  expect(times({ hour: "10", frequency: "custom", times: "" })).toBe("10:00");
  expect(remindPlanText(at(18, 8), { hour: "10", frequency: "custom", times: "abc" })).toBe("没认出时间点，先按每天 10:00 提醒一次，下一次：今天 10:00。");
});

test("当天改成自己定时间点:比上次发的晚才发,错过的只补最近一个", () => {
  const opts = { frequency: "custom", times: "8:00, 12:00, 16:00" };
  // 早上 9 点发过,13 点改:12 点那次补一条,16 点照发
  expect(simulate(at(18, 13, 0), opts, { hours: 6, step: 1, state: { lastSlot: "2026-10-18 09:00" } }).sent).toEqual(["18日 13:00", "18日 16:00"]);
  // 晚上 21 点发过再改:今天不再发,明天 8 点起
  expect(simulate(at(18, 21, 30), opts, { hours: 12, step: 1, state: { lastSlot: "2026-10-18 21:00" } }).sent).toEqual(["19日 08:00"]);
});

test("上一版的去重记录(日期#第几个):换成时刻再比,不重发", () => {
  const opts = { hour: "9", frequency: "custom", times: "9:00, 14:30, 18:00" };
  expect(remindSlotToSend(at(18, 15), opts, { lastSlot: "2026-10-18#1" })).toBeNull();
  expect(remindSlotToSend(at(18, 18, 5), opts, { lastSlot: "2026-10-18#1" })?.key).toBe("2026-10-18 18:00");
});

test("预览文案:每隔几小时和多个时间点", () => {
  expect(remindPlanText(at(18, 13), { hour: "9", frequency: "hours", every: "3" })).toBe("每天从 9:00 起每隔 3 小时提醒一次（9:00、12:00、15:00、18:00、21:00，一天 5 次），下一次：今天 15:00。");
  expect(remindPlanText(at(18, 22), { hour: "8", frequency: "hours", every: "1" })).toBe("每天从 8:00 起每隔 1 小时提醒一次（8:00 到 23:00，一天 16 次），下一次：今天 23:00。");
  expect(remindPlanText(at(18, 15), { frequency: "custom", times: "9:00, 14:30, 18:00" })).toBe("每天 9:00、14:30 和 18:00 各提醒一次（一天 3 次），下一次：今天 18:00。");
});

test("预览参数:表单里没保存的覆盖配置,时间点清空也算数", () => {
  const cfg = { remindHour: "9", remindFrequency: "daily", remindEvery: "3", remindTimes: "9:00, 18:00" };
  expect(remindOpts(cfg)).toEqual({ hour: "9", frequency: "daily", every: "3", times: "9:00, 18:00" });
  const q = new URLSearchParams({ frequency: "custom", times: "" });
  expect(remindOpts(cfg, q)).toEqual({ hour: "9", frequency: "custom", every: "3", times: "" });
});
