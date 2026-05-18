# Personal Task Hub Implementation

## Goal

Turn the artifact dashboard from a review-centric surface into a personal task hub while keeping the existing JSON storage and no-build frontend.

## Scope

- Add lightweight personal state to `state.json`.
- Add quick create, quick note, quick checkpoint, personal shortcuts, and organizing actions.
- Keep existing review workflow available but stop expanding it.

## Review Slices

- `done` Slice 1: personal state and APIs.
- `done` Slice 2: dashboard and detail page personal workflows.
- `done` Slice 3: tests, browser validation, commit, and push.

## Validation

- Run `npm run check`.
- Verify the dashboard in browser.
- Verify quick create and personal action flows against a temporary artifact root where needed.
