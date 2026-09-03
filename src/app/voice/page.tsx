import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { VoiceBar } from "@/components/voice/voice-bar";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Voice" };
export const dynamic = "force-dynamic";

/**
 * Voice control, on its own page.
 *
 * Not in the header: a microphone button on every page invites accidental
 * recording, and this is the kind of thing someone opens deliberately, puts the
 * phone down, and works through a stack of order slips with.
 */
export default function VoicePage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Voice"
        description="Speak in English or Urdu. Opening a page and asking for a figure happen straight away. An order or a payment is only filled in for you - you still press Save."
      />

      <VoiceBar />

      <Card className="p-5">
        <h2 className="text-sm font-semibold">What you can say</h2>

        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <Phrases
            title="Open a page"
            note="Happens immediately."
            items={[
              ["open receivables", "udhar dikhao"],
              ["show bookings", "bookings kholo"],
              ["go to products", "stock kholo"],
              ["open new booking", "naya order kholo"],
            ]}
          />
          <Phrases
            title="Ask a figure"
            note="Answered out loud. Nothing changes."
            items={[
              ["how much profit today", "aaj ka munafa kitna hai"],
              ["revenue this month", "is mahine ki bikri kitni hai"],
              ["how much outstanding", "kitna udhar hai"],
              ["how much mango bottle 250 stock", "aam bottle 250 ka stock kitna hai"],
              ["Corner Store balance", "Corner Store ka balance kitna hai"],
              ["how many orders today", "aaj kitne order huye"],
            ]}
          />
          <Phrases
            title="Book an order"
            note="Filled in for you. You press Save."
            items={[
              [
                "sell twenty packs mango bottle 250 to Corner Store",
                "bees packs aam bottle 250 Corner Store ko bech do",
              ],
              [
                "book 30 apple bottle 250 for Central Mart at 500",
                "tees seb bottle 250 Central Mart ko 500 ka becho",
              ],
              // More than one line in a single breath, split on "and" / "aur".
              [
                "sell 20 mango bottle 250 and 30 apple bottle 250 to Corner Store",
                "bees aam aur tees seb Corner Store ko bech do",
              ],
            ]}
          />
          <Phrases
            title="Receive stock"
            note="Filled in for you. You press Save."
            items={[
              ["purchased 500 chocolate at cost 12", "das hazar aam bottle 250 aaye, cost do sau"],
              [
                "received 200 apple bottle 250 cost 300",
                "paanch sau seb bottle 250 khareede cost teen sau",
              ],
            ]}
          />
          <Phrases
            title="Cash sale at the counter"
            note='Say "cash" or "nagad" - otherwise it is booked to the shop on credit.'
            items={[
              ["sell 5 chocolate cash in Downtown", "paanch chocolate cash bech diye Downtown"],
            ]}
          />
          <Phrases
            title="Record a payment"
            note="Filled in for you. You press Save."
            items={[
              ["payment received 5000 from Corner Store", "invoice 12 ka paanch hazar aa gaya"],
              ["received 1200 from Central Mart", "Central Mart se barah sau mila"],
            ]}
          />
        </div>

        <div className="mt-5 space-y-2 border-t pt-4 text-xs text-muted-foreground">
          <p>
            <strong className="text-foreground">Numbers work in both languages.</strong>{" "}
            &ldquo;twenty five&rdquo;, &ldquo;pachees&rdquo;, &ldquo;ek sau bees&rdquo;,
            &ldquo;paanch hazar&rdquo;, &ldquo;۲۵&rdquo; are all understood. So are everyday product
            names - aam, seb, aaru, lichi, anaar.
          </p>
          <p>
            <strong className="text-foreground">&ldquo;Kal&rdquo; is read as yesterday</strong>,
            since this records what already happened. The date it worked out is always shown before
            you save.
          </p>
          <p>
            <strong className="text-foreground">
              Nothing is deleted or edited by voice, ever.
            </strong>{" "}
            Those work by record number, and speech recognition confuses twelve and twenty - which
            would not fail, it would succeed on the wrong record. Removing or changing a batch, a
            sale, a booking or a payment is done on its own page, where you can see what you are
            touching.
          </p>
          <p>
            <strong className="text-foreground">No microphone? Type it.</strong> The box above the
            examples runs the same interpreter, which is also the quickest way to check a phrasing
            or fix one that was misheard.
          </p>
          <p>
            Needs Chrome, Edge or a recent Safari, and an internet connection - the browser does the
            listening. Everything here can also be{" "}
            <Link href="/bookings/new" className="underline">
              typed
            </Link>
            .
          </p>
        </div>
      </Card>
    </div>
  );
}

function Phrases({
  title,
  note,
  items,
}: {
  title: string;
  note: string;
  items: [string, string][];
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      <ul className="mt-2 space-y-2">
        {items.map(([en, ur]) => (
          <li key={en} className="text-sm">
            <span className="block">&ldquo;{en}&rdquo;</span>
            <span className="block text-muted-foreground">&ldquo;{ur}&rdquo;</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
