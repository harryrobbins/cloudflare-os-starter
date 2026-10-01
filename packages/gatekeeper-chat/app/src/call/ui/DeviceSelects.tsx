// Camera, microphone and speaker pickers, shared by the pre-join pane and the in-call settings.
//
// Native `<select>`s: keyboard and screen-reader behaviour for free, and nothing here is a form, so
// there is no submit to guard against. Device labels are blank until the page has been granted a
// device once, which is why the list is re-read after the preview starts.

import { useEffect, useState, type ReactNode } from "react";

import type { CallEngine, DeviceChoice } from "../engine/types.js";

export interface DeviceLists {
  readonly audioInputs: readonly MediaDeviceInfo[];
  readonly videoInputs: readonly MediaDeviceInfo[];
  readonly audioOutputs: readonly MediaDeviceInfo[];
}

const NO_DEVICES: DeviceLists = { audioInputs: [], videoInputs: [], audioOutputs: [] };

/** The engine's device lists, refreshed on `refresh` changes and on the browser's `devicechange`. */
export function useDeviceLists(engine: CallEngine | null, refresh: unknown): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>(NO_DEVICES);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (devices?.addEventListener === undefined) return;
    const onChange = (): void => setTick((value) => value + 1);
    devices.addEventListener("devicechange", onChange);
    return () => devices.removeEventListener("devicechange", onChange);
  }, []);
  useEffect(() => {
    if (engine === null) return;
    let live = true;
    engine
      .listDevices()
      .then((next) => {
        if (live) setLists(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [engine, refresh, tick]);
  return lists;
}

/** Whether this browser can route audio to a chosen output (Chromium and Firefox; not Safari). */
export function canChooseOutput(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export function DeviceSelects({
  lists,
  choice,
  onChange,
  compact = false,
}: {
  lists: DeviceLists;
  choice: DeviceChoice;
  onChange: (patch: Partial<DeviceChoice>) => void;
  compact?: boolean;
}): ReactNode {
  return (
    <div className={compact ? "flex flex-col gap-2" : "grid gap-2 sm:grid-cols-3"}>
      <DeviceSelect
        label="Camera"
        devices={lists.videoInputs}
        value={choice.videoInputId}
        onChange={(videoInputId) => onChange({ videoInputId })}
      />
      <DeviceSelect
        label="Microphone"
        devices={lists.audioInputs}
        value={choice.audioInputId}
        onChange={(audioInputId) => onChange({ audioInputId })}
      />
      {canChooseOutput() && lists.audioOutputs.length > 0 && (
        <DeviceSelect
          label="Speakers"
          devices={lists.audioOutputs}
          value={choice.audioOutputId}
          onChange={(audioOutputId) => onChange({ audioOutputId })}
        />
      )}
    </div>
  );
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
}: {
  label: string;
  devices: readonly MediaDeviceInfo[];
  value: string | null;
  onChange: (deviceId: string | null) => void;
}): ReactNode {
  // A remembered device that is no longer plugged in reads as the default rather than as a blank.
  const known = value !== null && devices.some((device) => device.deviceId === value);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium text-kumo-subtle">
      {label}
      <select
        value={known ? value : ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="h-8 min-w-0 cursor-pointer truncate rounded-lg border border-kumo-line bg-kumo-control px-2 text-[12px] text-kumo-default hover:border-kumo-ring"
      >
        <option value="">System default</option>
        {devices
          .filter((device) => device.deviceId !== "" && device.deviceId !== "default")
          .map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </option>
          ))}
      </select>
    </label>
  );
}
