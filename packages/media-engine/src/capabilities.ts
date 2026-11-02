import { CAPABILITIES, type CapabilityName, type CapabilityReport, type CapabilityState } from "@wasm-player/contracts";

export function capabilityReport(
  entries: Partial<Record<CapabilityName, boolean | CapabilityState>>
): CapabilityReport {
  const report = {} as CapabilityReport;
  for (const name of CAPABILITIES) {
    const entry = entries[name];
    if (entry === undefined) {
      report[name] = { available: false, reason: "not probed" };
    } else if (typeof entry === "boolean") {
      report[name] = entry ? { available: true } : { available: false, reason: "unsupported" };
    } else {
      report[name] = entry;
    }
  }
  return report;
}

export function allCapabilities(available: boolean, reason?: string): CapabilityReport {
  const report = {} as CapabilityReport;
  for (const name of CAPABILITIES) {
    const state: CapabilityState = { available };
    if (!available && reason !== undefined) state.reason = reason;
    report[name] = state;
  }
  return report;
}
