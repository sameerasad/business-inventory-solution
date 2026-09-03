-- A short spoken nickname for records whose real name is hard for speech
-- recognition to hear.
--
-- Urdu place and shop names ("Rakshani bazar", "Khwaja ajmer nagri") come back
-- from the browser's speech engine mangled, and no amount of fuzzy matching
-- fixes a transcription that shares no letters with the target. An alias lets
-- the owner choose a word the engine CAN hear and point it at the record.
--
-- Nullable and unconstrained on purpose: it is a convenience, not an identity.
-- Two shops may share an alias - voice will simply report the ambiguity rather
-- than guess, exactly as it does for two similar real names.
ALTER TABLE "areas"   ADD COLUMN "voice_alias" TEXT;
ALTER TABLE "shops"   ADD COLUMN "voice_alias" TEXT;
ALTER TABLE "bookers" ADD COLUMN "voice_alias" TEXT;
