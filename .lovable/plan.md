# Spin button guidance

## Changes
- Rename the idle gacha action from “Pull the lever” to “Click To Spin”.
- Pulse and glow the spin button only while spins are available and the machine is ready.
- Keep the no-spins button clickable; when pressed, smoothly scroll to the demo refill control and briefly pulse it.
- Connect this guidance only where a refill control exists, without changing spin or prize logic.

## Verification
- Test available-spin and empty-spin states on the mobile landing page.
- Confirm the refill button receives focus and animation after the empty-spin action.
- Confirm reduced-motion preferences suppress movement and the app still builds.
