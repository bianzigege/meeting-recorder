// 提醒调度的测试:用假时间模拟服务每 10 分钟检查一次。运行:bun test
import { test, expect } from "bun:test";
import { remindHours, remindSlotToSend, remindPlanText } from "./core.js";

// 从 start 开始每 10 分钟检查一次,跑 hours 小时,返回发提醒的时刻(HH:MM)。state 像 reminders.json 一样跨检查保留
function simulate(start, opts, { hours = 24, state = {} } = {}) {
  const sent = [];
  for (let t = start.getTime(); t < start.getTime() + hours * 3600_000; t += 10 * 60_000) {
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
  expect(remindHours({ hour: "15", frequency: "halfday" })).toEqual([3, 15]);
  expect(simulate(at(18, 0, 0), { hour: "15", frequency: "halfday" }).sent).toEqual(["18日 03:00", "18日 15:00"]);
});

test("老配置没有频率字段:按每天一次", () => {
  expect(remindHours({ hour: "9" })).toEqual([9]);
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
  expect(remindSlotToSend(at(18, 10), opts, {}, "2026-10-27")?.key).toBe("2026-10-27#0");
  expect(remindSlotToSend(at(18, 10), opts, { lastSlot: "2026-10-27#0" }, "2026-10-27")).toBeNull();
});

test("0 点就是 0 点,乱填按 9 点", () => {
  expect(remindHours({ hour: "0", frequency: "halfday" })).toEqual([0, 12]);
  expect(remindHours({ hour: "", frequency: "daily" })).toEqual([9]);
  expect(remindHours({ hour: "30", frequency: "daily" })).toEqual([23]);
});

test("预览文案写清下一次", () => {
  expect(remindPlanText(at(18, 8), { hour: "9", frequency: "daily" })).toBe("每天 9:00 提醒一次，下一次：今天 9:00。");
  expect(remindPlanText(at(18, 10), { hour: "9", frequency: "daily" })).toBe("每天 9:00 提醒一次，下一次：明天 9:00。");
  expect(remindPlanText(at(18, 10), { hour: "9", frequency: "halfday" })).toBe("每天 9:00 和 21:00 各提醒一次，下一次：今天 21:00。");
  expect(remindPlanText(at(18, 22), { hour: "9", frequency: "halfday" })).toBe("每天 9:00 和 21:00 各提醒一次，下一次：明天 9:00。");
});
