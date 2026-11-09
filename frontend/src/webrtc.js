// Copyright (c) 2026 Amazon
// SPDX-License-Identifier: MIT-0

import { openStream, closeStream } from "./api.js";

/**
 * Start a WHEP WebRTC stream into a <video> element.
 *
 * The browser creates a recvonly offer, we hand the SDP to the backend proxy
 * (which forwards it to Ring's WHEP endpoint), then apply the SDP answer.
 * Returns a handle with stop() to close the peer connection and the Ring session.
 */
export async function startStream(deviceId, videoEl, componentId, onState) {
  const notify = typeof onState === "function" ? onState : () => {};
  // STUN lets the browser learn its public address so it can reach Ring.
  // This is the server Ring's WHEP guide uses. It's a third party that sees
  // the viewer's IP address, so it's named in PRIVACY.md. To avoid it, run
  // your own STUN/TURN server and update both places.
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  // We only receive media from the camera.
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const remoteStream = new MediaStream();
  videoEl.srcObject = remoteStream;
  pc.ontrack = (event) => remoteStream.addTrack(event.track);

  // Surface the live/dropped state to the UI. "connected" means media is
  // flowing; disconnected/failed/closed mean the live session dropped.
  let closedByUs = false;
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") notify("live");
    else if ((s === "disconnected" || s === "failed" || s === "closed") && !closedByUs) {
      notify("disconnected");
    }
  };

  let sessionUrl;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, 5000);

    const answer = await openStream(deviceId, pc.localDescription.sdp, componentId);
    sessionUrl = answer.sessionUrl;
    await pc.setRemoteDescription({ type: "answer", sdp: answer.answerSdp });
  } catch (err) {
    // Don't leak the peer connection (or a Ring session) when setup fails;
    // the caller may retry with a fresh one.
    closedByUs = true;
    pc.close();
    if (sessionUrl) await closeStream(sessionUrl).catch(() => {});
    throw err;
  }

  return {
    pc,
    sessionUrl,
    async stop() {
      closedByUs = true;
      try {
        pc.getReceivers().forEach((r) => r.track && r.track.stop());
        pc.close();
      } catch (_) {}
      try {
        await closeStream(sessionUrl);
      } catch (_) {}
    },
  };
}

// Wait until ICE candidate gathering completes (or a timeout) so the offer SDP
// includes candidates — simplest reliable path without trickle ICE.
function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, timeoutMs);
  });
}
