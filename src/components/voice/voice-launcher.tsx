"use client";

import { useState } from "react";
import { Mic } from "lucide-react";

import { VoiceBar } from "@/components/voice/voice-bar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Voice, reachable from anywhere.
 *
 * A floating button on every page that opens the same VoiceBar the Voice page
 * uses - so every command works from wherever you happen to be standing,
 * rather than only after navigating away from it.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not fill the form you are looking at. It is the general module:
 *    it navigates, answers questions, and proposes writes through its own
 *    confirmation card. A page's own fields are untouched.
 *  - It does not go to /voice. Going there loses your place, which is the
 *    whole reason a floating panel is better than a link.
 *  - It does not touch the network until the microphone is pressed. Merely
 *    existing on a page costs nothing, which matters when the daily token
 *    allowance is what limits how many commands a day the feature can serve.
 *
 * Built on the Dialog already in the project rather than a hand-rolled panel:
 * that brings a portal - so nothing clips it - a focus trap, and Escape to
 * close, none of which is worth writing again.
 */
export function VoiceLauncher({ whisperAvailable }: { whisperAvailable: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open voice commands"
        title="Voice commands"
        className={
          // Bottom right, above everything, and clear of a phone's home bar.
          // z-40 keeps it under the dialog overlay rather than floating over
          // the panel it opened.
          "fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full " +
          "bg-primary text-primary-foreground shadow-lg transition-transform " +
          "hover:scale-105 focus-visible:outline-none focus-visible:ring-2 " +
          "focus-visible:ring-ring focus-visible:ring-offset-2 " +
          "[padding-bottom:env(safe-area-inset-bottom)]"
        }
      >
        <Mic className="h-6 w-6" />
      </button>

      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Voice</DialogTitle>
          <DialogDescription>
            Say an order, a payment, a question, or where to go. Nothing is saved until you confirm
            it.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open, so the microphone hooks are not holding a
            stream open behind every page in the app. */}
        {open ? <VoiceBar whisperAvailable={whisperAvailable} /> : null}
      </DialogContent>
    </Dialog>
  );
}
