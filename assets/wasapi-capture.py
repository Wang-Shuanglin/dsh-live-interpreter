#!/usr/bin/env python3
"""WASAPI loopback capture helper for dsh-live-interpreter.

Captures whatever the default output device is playing (system audio) and
streams it as 16 kHz mono signed-16-bit little-endian PCM on stdout.

Unlike the "Stereo Mix" recording endpoint, this uses the Windows WASAPI
loopback API through the `soundcard` package, which hooks the *default render
device itself*. That is the only reliable way to hear a USB / Bluetooth
speaker that never passes through the onboard Realtek chip.

Usage:
    python wasapi-capture.py [--sr 16000] [--frames 4000] [--device NAME]

The process writes raw PCM16LE to stdout and diagnostics to stderr, then runs
until its stdin is closed or it is killed.
"""
import sys
import argparse


def log(msg):
    sys.stderr.write("[wasapi] %s\n" % msg)
    sys.stderr.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sr", type=int, default=16000)
    parser.add_argument("--frames", type=int, default=4000)
    parser.add_argument("--device", type=str, default="")
    args = parser.parse_args()

    try:
        import soundcard as sc
        import numpy as np
    except Exception as exc:  # pragma: no cover - environment dependent
        log("missing dependency: %s" % exc)
        log("install with: python -m pip install soundcard numpy")
        return 3

    try:
        speaker = sc.default_speaker()
        log("default speaker: %s" % speaker.name)
        mics = sc.all_microphones(include_loopback=True)
        target = None
        if args.device:
            for m in mics:
                if getattr(m, "isloopback", False) and m.name == args.device:
                    target = m
                    break
            if target is None:
                log("no loopback device named %r" % args.device)
                return 4
        else:
            # Loopback device for the *default* speaker is what "system audio" means.
            for m in mics:
                if getattr(m, "isloopback", False) and m.name == speaker.name:
                    target = m
                    break
            if target is None:
                for m in mics:
                    if getattr(m, "isloopback", False):
                        target = m
                        break
        if target is None:
            log("no WASAPI loopback device found")
            for m in mics:
                log("  %s loopback=%s" % (m.name, getattr(m, "isloopback", None)))
            return 5
        log("loopback device: %s" % target.name)

        chunk = max(1, int(args.frames))
        recorder = target.recorder(samplerate=args.sr, channels=1)
        with recorder:
            log("capturing at %d Hz" % args.sr)
            out = sys.stdout.buffer
            while True:
                data = recorder.record(numframes=chunk)
                if data is None or len(data) == 0:
                    continue
                mono = data
                if getattr(mono, "ndim", 1) == 2:
                    mono = mono.mean(axis=1)
                # Clip defensively then scale to int16; loopback can exceed 1.0.
                mono = np.clip(mono, -1.0, 1.0)
                pcm = (mono * 32767.0).astype("<i2").tobytes()
                out.write(pcm)
                out.flush()
    except KeyboardInterrupt:
        return 0
    except Exception as exc:  # pragma: no cover
        import traceback
        log(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
