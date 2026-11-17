# Changelog

## 0.1.4 (2026-11-17)

- SDK 0.16.0 and GameKit 0.10.6: the kit's on-screen keyboard on the box's touch screens
  (phones, tablets and PCs keep their own keyboards).
- Every field people type in is a real input with a length limit inside a form, so Enter
  works: song search (guests and staff), the guest's name, the Spotify client id and pasted
  address (no automatic capital), the rules, the app's name, library titles and artists.
  Rule numbers are text fields with a number pad; the server checks the ranges.
- Dropdowns (the speaker) open the kit's big-button list on those screens; long choices wrap.
- On a shared screen (a request kiosk) the guest page doesn't remember the last person's
  name or show "Your requests", and starts fresh 5 seconds after each request.

## 0.1.3 (2026-11-15)

- SDK 0.14.0 and GameKit 0.8.0. No changes to the app (the new hosting commands are for
  games with a host phone).

## 0.1.2 (2026-11-14)

- SDK 0.13.2 and GameKit 0.7.4 (`AudioEndReason` from the SDK; `JoinAddress align="start"`).
- Every way a box song can end (finished, stopped, replaced, disconnected, error) is now
  checked against the mock box too, not only with unit fakes. Box 0.16.0's "stop all sound"
  scene ends a song as "stopped", so the queue waits until staff carry on.

## 0.1.1 (2026-11-14)

- SDK 0.13.1 and GameKit 0.7.3.
- Box speakers (box 0.15.4's `endReason`): the queue moves on when a song finishes, and
  after a song that couldn't play (staff see a note). When a song was stopped, taken over by
  something else or the speaker went away, the queue waits and the staff page says why,
  with "Carry on with the queue" (and "Take the speaker over" when something else is
  playing). Older boxes work as before.
- TV: the guest address is printed under the QR code ("or go to …"), wrapped to fit any
  venue address; the idle "Scan the code to request one." no longer gets cut off.

## 0.1.0 (2026-11-13)

- First release: guest requests, rules, the staff queue, the TV view, Spotify (personal
  use) and music files on the box's speakers or the speaker page.
