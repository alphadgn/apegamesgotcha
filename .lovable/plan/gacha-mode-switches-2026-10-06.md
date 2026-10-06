# Gacha mode switches

## Changes
- Replace the two reveal buttons with one accessible switch between “One by one” and “Reveal all”.
- Add a second switch between “One spin” and “Spin all”.
- Make “Spin all” load every available spin remaining in the current five-slot cycle, capped by the player’s available spins.
- Preserve empty-spin refill guidance after the selected spins are consumed.
- Increase the ready-button pulse frequency by about 30% and make its brightest point more prominent.

## Verification
- Test both switches and confirm their labels and states on mobile.
- Test Spin all with three spins and confirm one action consumes all three.
- Confirm the empty action scrolls to and highlights refill.
- Confirm reduced-motion behavior and a clean build.
