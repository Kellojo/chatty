---
name: google-maps-route
title: Google Maps route
description: Build a Google Maps directions link from an ordered list of locations (multi-stop route) and present it to the user.
triggers:
  - intent: 'create a route'
  - intent: 'directions between places'
  - intent: 'plan a trip with stops'
  - keyword: 'route'
when: Use when the user provides several locations (cities, addresses, landmarks) and wants a route or directions linking them in Google Maps.
tools: []
enabled: true
source: bundled
version: '1.0.0'
author: ai-chat
---

Build a Google Maps directions URL from the user's list of locations.

## 1. Collect and order the stops

- Extract every location the user mentions: city names, addresses, landmarks, or "current location" if they say so.
- Preserve the user's stated order. If no order is implied, order stops to minimize backtracking and say what you chose.
- If the user gives only two locations, treat them as origin and destination.

## 2. Build the URL

Use the Google Maps directions URL format:
`https://www.google.com/maps/dir/<origin>/<waypoint1>/<waypoint2>/.../<destination>/`

- URL-encode each stop (spaces as `+` or `%20`, keep commas).
- Use the user's own words for stop names — Google Maps resolves landmarks and addresses itself; do not guess coordinates.
- First entry is the origin, last is the destination, everything between are waypoints.
- For travel modes other than driving, append `?travelmode=walking`, `?travelmode=bicycling`, or `?travelmode=transit` (driving is the default and needs no parameter).

## 3. Present

- Output the URL as an inline markdown link with a short label, e.g. `[Open route in Google Maps](https://www.google.com/maps/dir/Berlin/Munich/)`. Never put the raw URL in a code block or on its own line — always a clickable markdown link.
- Also list the stops as an ordered list so the user can sanity-check the order before opening the link.
- Mention the travel mode assumed and how to change it (e.g. "say 'make it walking' to switch").

## Notes

- Do not fabricate distances or travel times — the link opens live data in Google Maps.
- If a location is ambiguous (e.g. "Springfield"), ask which one, or include state/country in that stop's text.
