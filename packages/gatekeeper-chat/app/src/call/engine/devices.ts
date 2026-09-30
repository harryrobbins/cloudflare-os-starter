// Device helpers the UI can use alongside the engine.

/**
 * Routes a remote `<audio>`/`<video>` element to the chosen output (`CallSnapshot.audioOutputId`).
 * Resolves false where `setSinkId` is unsupported (Firefox without the pref, older Safari) or the
 * device is gone; null means the system default.
 */
export async function applyAudioOutput(element: HTMLMediaElement, deviceId: string | null): Promise<boolean> {
  const sink = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof sink.setSinkId !== "function") return false;
  try {
    await sink.setSinkId(deviceId ?? "");
    return true;
  } catch {
    return false;
  }
}

export function splitDevices(devices: readonly MediaDeviceInfo[]): {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
} {
  return {
    audioInputs: devices.filter((device) => device.kind === "audioinput"),
    videoInputs: devices.filter((device) => device.kind === "videoinput"),
    audioOutputs: devices.filter((device) => device.kind === "audiooutput"),
  };
}
