import { isPin, type Pin } from "./ids.ts";
import { isCredentialPair } from "../protocol/auth.ts";
import type { Credentials } from "../protocol/parse.ts";

export type Pairing =
  | { kind: "unpaired" }
  | { kind: "pairing"; pin: Pin }
  | { kind: "paired"; credentials: Credentials }
  | { kind: "failed"; credentials: Credentials };

export type PairingEvent =
  | { type: "begin-pin"; pin: string }
  | { type: "pin-cancelled" }
  | { type: "pin-accepted"; credentials: Credentials }
  | { type: "auth-failed" }
  | { type: "forget" }
  | { type: "not-authenticated" }
  | { type: "transport" }
  | { type: "before-auth" };

export function pairingFromStored(credentials: Credentials | null): Pairing {
  if (!credentials || !isCredentialPair(credentials.clientId, credentials.clientSecret)) {
    return { kind: "unpaired" };
  }
  return {
    kind: "paired",
    credentials: {
      clientId: credentials.clientId.toLowerCase(),
      clientSecret: credentials.clientSecret.toLowerCase(),
    },
  };
}

export function reducePairing(pairing: Pairing, event: PairingEvent): Pairing {
  switch (event.type) {
    case "not-authenticated":
    case "before-auth":
      return pairing;
    case "transport":
      return pairing.kind === "pairing" ? { kind: "unpaired" } : pairing;
    case "auth-failed":
      return pairing.kind === "paired" ? { kind: "failed", credentials: pairing.credentials } : pairing;
    case "forget":
      return { kind: "unpaired" };
    case "pin-cancelled":
      return pairing.kind === "pairing" ? { kind: "unpaired" } : pairing;
    case "begin-pin":
      if (pairing.kind === "paired" || !isPin(event.pin)) {
        return pairing;
      }
      return { kind: "pairing", pin: event.pin };
    case "pin-accepted": {
      if (pairing.kind !== "pairing") {
        return pairing;
      }
      const credentials = {
        clientId: event.credentials.clientId.toLowerCase(),
        clientSecret: event.credentials.clientSecret.toLowerCase(),
      };
      if (!isCredentialPair(credentials.clientId, credentials.clientSecret)) {
        return pairing;
      }
      return { kind: "paired", credentials };
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function shouldAutoPair(input: {
  previousPhase: string;
  phase: string;
  offerPin: boolean;
  pairing: Pairing;
}): boolean {
  return input.offerPin
    && input.pairing.kind === "unpaired"
    && input.phase === "need-pair"
    && (input.previousPhase === "wait-auth" || input.previousPhase === "authenticating");
}
