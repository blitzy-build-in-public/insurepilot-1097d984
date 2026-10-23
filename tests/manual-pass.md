# Plant Parent — manual pass

A person runs this pass on a real desktop and a real phone, after both
automated suites pass. It covers the browsers the automated Chromium suite
does not, Firefox and Safari, and it resolves the file-mode assumptions A1
(Edge) and A2 (desktop Safari).

## Before you start

The automated gates need Node.js 22.5.0 or later with its bundled npm, and
the same Node.js runs the server for served LAN mode below. The first three
gates need nothing more; the next two commands install the Playwright package
and Chromium that the browser gate drives. All of these are development tools
and are never shipped: the app itself needs no install, build or package, and
opens straight in a browser. Run the gates from the repository root:

```bash
node --check app.js
node --test "tests/unit/*.test.js"
node --test --experimental-test-coverage --test-coverage-include="app.js" "tests/unit/*.test.js"
npm ci --prefix tests
npx --prefix tests playwright install chromium   # add --with-deps on a fresh Linux host
node --test --test-concurrency=1 "tests/browser/*.test.js"
```

Start this pass only once every command passes. The coverage run passes when
every uncovered line it lists falls in blocks 3–5 of `app.js` (rendering,
event wiring and entry). Once the install has run, `npm --prefix tests test`
runs both suites in turn.

## Run modes

- **File mode.** Open `index.html` straight from the file system, by
  double-clicking it or with File → Open. The address bar shows
  `file://…/index.html`.
- **Served LAN mode, for the phone.** On the computer, from the repository
  root, run:

  ```bash
  HOST=0.0.0.0 node tests/support/static-server.js 8080
  ```

  - `HOST` is the address the server listens on. Unset or empty, it is
    `127.0.0.1`, which only this computer can reach; `0.0.0.0` listens on
    every IPv4 interface, so a phone on the same network can reach it.
  - The port is the one optional argument, a decimal number from 0 to 65535.
    Without it the server uses port 0: the system picks a free port, and the
    printed URL shows it. Here it is fixed at 8080 so the phone URL is
    predictable. An invalid port, or more than one argument, prints the usage
    line and exits with code 1.

  The server prints the LAN addresses it answers on. On a phone on the same
  network, open `http://<computer LAN IP>:8080/index.html`. The computer's
  firewall may need to allow incoming connections on port 8080. The server
  serves only the repository root's own files and returns 404 for everything
  else. Stop it with Ctrl+C when the session ends.

  A LAN address is not a secure context, so adding a plant here also proves
  that ids work outside one: ids come from `crypto.getRandomValues` rather
  than `crypto.randomUUID`.

Phones use served mode only; file mode is a desktop run mode.

## Starting fresh

Begin each session with no saved plants. Delete the key
`plant-parent.plants.v1` in the browser's storage inspector, or clear that
site's data:

- Firefox: DevTools → Storage → Local Storage.
- Edge: DevTools → Application → Local storage.
- Safari on macOS: Web Inspector → Storage → Local Storage. Turn on Safari
  Settings → Advanced → "Show features for web developers" first.
- Safari on iOS: delete the computer's address under Settings → Safari →
  Advanced → Website Data (Settings → Apps → Safari on recent iOS).

Private windows keep storage only until they close, so never use one for
criterion 7.

## Expected texts

Compare what the page shows against these strings, character for character.

- Empty state, in place of the list: "No plants yet. Add your first plant
  above."
- Field messages, directly below their field: "Enter a plant name", "Name must
  be 80 characters or fewer", "Enter a date", "Date cannot be in the future"
- Notices, below the Plant Parent heading and above the form: "Storage is
  unavailable, so plants will not be kept after this page is closed.", "Some
  saved data could not be read.", "Could not save your last change. It will be
  lost when this page is closed."
- Each **Water now** button's accessible name: `Water now: <name>`, for
  example `Water now: Monstera`.
- Dates appear in `en-US` short form, for example "Mar 3, 2025". "Today" is
  the device's local calendar date.

## Criteria checklist

Each item gives the steps and the expected result. "Today" and "yesterday"
are local dates on the device at the time of the check.

Test strings, for pasting:

- 81 characters, for criterion 9:
  `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
- 80 characters with no spaces, for criterion 13:
  `WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW`
- A stored array mixing valid and invalid entries, for criterion 10. Only
  Monstera and Cactus are valid:
  `[{"id":"p-1","name":"Monstera","lastWatered":"2025-03-01"},{"id":"p-2","name":"","lastWatered":"2025-03-01"},{"id":"p-3","name":"Fern","lastWatered":"2025-02-30"},42,{"id":"p-5","name":"Cactus","lastWatered":"2025-03-02"},{"id":"p-6","name":"Ivy"}]`

1. **First open.**
   - Steps: start fresh and open the page.
   - Expected: the form (Name, Last watered, **Add plant**) and the
     empty-state sentence are visible. No plant list and no notice is shown.
     Last watered shows today, and its native picker offers no day after
     today.
2. **Add a plant.**
   - Steps: type `Monstera` in Name, leave Last watered at today and press
     **Add plant**.
   - Expected: exactly one row, showing "Monstera" and "Last watered" followed
     by today's date. The empty-state sentence is gone. Name is empty and has
     focus.
3. **Order.**
   - Steps: start fresh and add Monstera, Fern and Cactus, in that order.
   - Expected: the rows read Monstera, Fern, Cactus from top to bottom. In
     the storage inspector, the value of `plant-parent.plants.v1` lists the
     entries' names in the same order: Monstera, Fern, Cactus.
4. **Past date.**
   - Steps: set Last watered to yesterday and add `Pothos`.
   - Expected: the Pothos row shows yesterday's date, and Last watered returns
     to today. In the storage inspector, the Pothos entry's `lastWatered` is
     yesterday's date in `YYYY-MM-DD` form.
5. **Water now.**
   - Steps: on a plant dated in the past, such as Pothos, press **Water now**.
     Then reload the page.
   - Expected: the row shows today at once, without a reload, and stays in
     its position. After the reload it still shows today. In the storage
     inspector, that plant's stored `lastWatered` is today's date in
     `YYYY-MM-DD` form after the press, and still is after the reload.
6. **No reordering.**
   - Steps: with at least three plants dated in the past, note the order of
     the rows and, in the storage inspector, the order of the stored `id`
     values. Then press **Water now** on the middle row, then the last, then
     the first.
   - Expected: after every press both the rows and the stored `id` values
     keep that order.
7. **Persistence.**
   - Steps: note every row's name, date and position. Reload. Open the same
     file or URL in a new tab or window. Quit the browser completely, relaunch
     it and open the same file or URL.
   - Expected: each view shows the same names, dates and order as before.
8. **Stored format.**
   - Steps: open the storage inspector and select `plant-parent.plants.v1`.
   - Expected: the value is a JSON array. Every entry has exactly the keys
     `id`, `name` and `lastWatered`, every `lastWatered` matches `YYYY-MM-DD`,
     and every `id` is `p-` followed by 32 lowercase hexadecimal digits.
9. **Refused input.**
   - Steps: note the rows and the stored value, then submit each sub-case with
     **Add plant**:
     - an empty name;
     - a name of spaces only;
     - the 81-character name above;
     - a valid name with an empty or incomplete date (clear the date, or
       leave one of its parts blank);
     - a valid name with a date after today, typed with the keyboard.
   - Expected: each sub-case shows its exact message under its field: "Enter
     a plant name" for the first two, "Name must be 80 characters or fewer"
     for the third, "Enter a date" for the fourth and "Date cannot be in the
     future" for the fifth. In the DOM inspector, the invalid field carries
     `aria-invalid="true"` and an `aria-describedby` naming its message's
     id: `plant-name-error` for Name, `last-watered-error` for Last watered.
     The Accessibility inspector shows that field as invalid and described by
     its message. No row is added, the stored value is unchanged, both fields
     keep exactly what was typed, and focus moves to the invalid field.
     Any edit to Name clears its message and removes both attributes. Last
     watered does the same only once the edit changes its value, so a partly
     entered date keeps its message until month, day and year are all entered.
10. **Corrupt storage.**
    - Steps: in the storage inspector, set the value of
      `plant-parent.plants.v1` to `{not json` and reload. Then set it to the
      mixed array above and reload.
    - Expected: each time, the page loads with no error in the console, and
      the notice "Some saved data could not be read." shows. With `{not json`
      the empty state shows. With the mixed array only Monstera and Cactus appear, in
      that order. The stored value stays exactly as set until the next add
      or **Water now**.
11. **Storage unavailable.**
    - Steps: block storage as the session describes and reload. Add two
      plants, one dated yesterday, and press **Water now** on that one. Then
      reload.
    - Expected: "Storage is unavailable, so plants will not be kept after this
      page is closed." shows, with no error. Adding and **Water now** still
      work for the session. After the reload the empty state and the notice
      show again.
12. **Network.**
    - Steps: open the Network panel with logs persisted across reloads, then
      reload. Add a plant, press **Water now** on it and reload again.
    - Expected: the only requests are `index.html`, `styles.css` and
      `app.js`: no `favicon.ico` and no other host. Adding and **Water now**
      make no request, and the reload repeats only those three files. A
      `data:` entry for the inline icon, if listed, is not a network request.
13. **No horizontal scrolling.**
    - Steps: add the 80-character name above and `Fern`, then press **Add
      plant** with Name empty so the Name message shows. Check at 360 px wide
      and at 1280 px wide.
    - Expected: at both widths nothing scrolls sideways, the long name wraps
      inside its row, and every button, field, row and message stays within
      the window.
14. **Keyboard.**
    - Steps: set up three plants, A, B and C, each dated before today, and
      reload. From here on use only the keyboard. Press Tab from the top of
      the page until A's **Water now** has focus and press Enter. Press Tab
      once and press Space on B's button. Press Tab once and press Enter on
      C's button. Press Shift+Tab until Name has focus, type `Ivy` and press
      Enter.
    - Expected:
      - Tab order is Name → Last watered (its segments) → **Add plant** → each
        **Water now** in list order.
      - Each button's accessible name is exactly `Water now: <name>`.
      - Enter and Space both activate **Water now**: the row shows today, and
        focus is on the same plant's button with a visible 3 px outline.
      - Shift+Tab walks back through the same elements in reverse to Name,
        and Enter adds Ivy with no pointer input.

## Sessions

Run each session in the current release of its browser, starting fresh, and
record every result in the results table.

### Desktop Firefox, current, file mode: criteria 1–14

- 1–9: through the UI. Read the stored values that 3, 4, 5, 6, 8 and 9 check in
  DevTools → Storage → Local Storage, and 9's field attributes in DevTools →
  Inspector (or DevTools → Accessibility).
- 10: DevTools → Storage → Local Storage, edit the value of
  `plant-parent.plants.v1`, then reload.
- 11: open `about:config`, set `dom.storage.enabled` to `false` and reload.
  Firefox then exposes `localStorage` as `null` rather than throwing, and the
  app must still show the unavailable notice. **Restore
  `dom.storage.enabled` to `true` afterwards.**
- 12: the Network panel, with Persist Logs turned on in its settings menu.
- 13: Responsive Design Mode at 360 px wide, then a normal window 1280 px
  wide.
- 14: keyboard only, reading each button's name in the Accessibility
  Inspector (DevTools → Accessibility). Tab stops several times inside Last
  watered, once per part of the date, before it reaches **Add plant**.

### Safari on iOS, current, served over the LAN: criteria 1–7, 9, 13 and 14's accessible names

- Start the server in served LAN mode and open the URL it prints in Safari on
  the phone.
- All criteria through the UI on the device. The phone has no inspector of
  its own, so read the stored values that 3, 4, 5, 6 and 9 check, and 9's field
  attributes, with Web Inspector from a Mac. On the phone, turn on Settings →
  Apps → Safari → Advanced → Web Inspector (Settings → Safari → Advanced on
  older iOS) and connect the phone to the Mac with a cable. In Safari on the
  Mac, with Safari Settings → Advanced → "Show features for web developers"
  on, choose the phone in the Develop menu, then the page, and use its
  Storage and Elements tabs.
- 7: quit Safari by swiping it away in the app switcher, then reopen it and
  the same URL.
- 9: dates are chosen in the native picker. Confirm that the picker offers no
  day after today. For the empty-date sub-case, type a valid name, tap Last
  watered, tap Reset in the picker, close the picker if it stays open, and
  confirm the field shows no date; then press **Add plant**. If the picker
  shows no Reset control, or the field still shows a date afterwards, the
  Notes cell records that the empty-date sub-case could not be run on that
  iOS version and what the picker offered, and that sub-case does not count
  as passed. iOS has no keyboard entry for a date, so no part of it can be
  left blank and the incomplete-date variant does not apply. If the picker
  does let a day after today be chosen, choose it and submit: the app must
  show "Date cannot be in the future", and the Notes cell records what the
  picker allowed.
- 13: at the device's own width, in portrait.
- 14 (accessible names): turn on VoiceOver (Settings → Accessibility →
  VoiceOver) and swipe to each **Water now** button. VoiceOver reads each one
  as `Water now: <name>`, followed by "button".

### Desktop Edge, current, file mode: spot check for A1, criteria 1, 2, 5, 7

Assumption A1: Edge, like Chromium, loads the script and stylesheet from
`file://` and keeps `localStorage` across reloads and browser restarts.

1. Start fresh and open `index.html` from the file system (criterion 1).
2. Add `Monstera` dated today (criterion 2), then add `Fern` dated yesterday.
3. Press **Water now** on Fern (criterion 5), then reload.
4. Quit Edge completely, making sure it is not still running in the
   background, then relaunch it and reopen the same file (criterion 7).

Record the outcome as described in "Recording spot-check outcomes".

### Desktop Safari on macOS, current, file mode: spot check for A2, criteria 1, 2, 5, 7

Assumption A2: Safari loads the classic script and stylesheet from `file://`
and provides `localStorage` there. Whether that storage survives quitting
Safari is unconfirmed; this spot check settles it.

Follow the same four steps as the Edge spot check, opening the file with
File → Open File (⌘O) and quitting Safari completely with ⌘Q before reopening
the file. Record the outcome as described in "Recording spot-check outcomes".

## Recording spot-check outcomes

Each Edge and macOS Safari spot check ends in one of three outcomes:

- **Pass:** the plants survive the reload and the relaunch.
- **Recorded file-mode limitation:** the page shows the storage-unavailable
  notice and still works for the session, or the plants survive the reload
  but not the relaunch. The Notes cell records what happened and names served
  mode as that browser's supported route.
- **Defect:** any other outcome, such as an uncaught error, a missing
  stylesheet or script, or data lost on reload while storage was granted. A
  defect is fixed before the build is finished, and the spot check is then
  re-run.

## Safari keyboard note

Safari on macOS moves Tab only between fields by default. Anyone repeating
criterion 14 there turns on Safari Settings → Advanced → "Press Tab to
highlight each item", or uses Option+Tab.

## Results

Fill in each row as its criterion is run: the browser version and the OS
version or device model, found as listed below, then the result, any notes,
the tester's name and the date. Record a re-run on a new row rather than
overwriting the earlier one.

- Firefox: menu button (☰) → Help → About Firefox; on macOS, Firefox →
  About Firefox in the menu bar.
- Edge: Settings and more (…) → Help and feedback → About Microsoft Edge,
  or open `edge://settings/help`.
- Safari on macOS: Safari → About Safari in the menu bar.
- Safari on iOS: Safari has no About page and is versioned with iOS.
  Record the version from Settings → General → About → iOS Version (iPadOS
  Version on an iPad) in the row's version slot, prefixed `iOS` or
  `iPadOS`, and the model from Model Name on the same screen. Do not record
  a separate Safari version.
- Desktop OS: on macOS, Apple menu → About This Mac; on Windows,
  Settings → System → About.

| Browser and version | OS or device | Run mode | Criterion | Result | Notes | Tester | Date |
|---|---|---|---|---|---|---|---|
| Firefox (version: ) | Desktop (OS: ) | File | 1 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 2 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 3 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 4 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 5 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 6 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 7 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 8 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 9 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 10 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 11 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 12 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 13 | Pending | | | |
| Firefox (version: ) | Desktop (OS: ) | File | 14 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 1 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 2 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 3 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 4 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 5 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 6 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 7 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 9 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 13 | Pending | | | |
| Safari on iOS (version: ) | iOS device (model: ) | Served (LAN) | 14 (accessible names) | Pending | | | |
| Edge (version: ) | Desktop (OS: ) | File, A1 spot check | 1 | Pending | | | |
| Edge (version: ) | Desktop (OS: ) | File, A1 spot check | 2 | Pending | | | |
| Edge (version: ) | Desktop (OS: ) | File, A1 spot check | 5 | Pending | | | |
| Edge (version: ) | Desktop (OS: ) | File, A1 spot check | 7 | Pending | | | |
| Safari (version: ) | macOS (version: ) | File, A2 spot check | 1 | Pending | | | |
| Safari (version: ) | macOS (version: ) | File, A2 spot check | 2 | Pending | | | |
| Safari (version: ) | macOS (version: ) | File, A2 spot check | 5 | Pending | | | |
| Safari (version: ) | macOS (version: ) | File, A2 spot check | 7 | Pending | | | |

`Pending` marks a row not yet run. Allowed Result values once it has run:

- `Pass`: the expected result appeared.
- `Fail`: the expected result did not appear. The Notes cell records what
  happened.
- `File-mode limitation`: spot checks only, as defined in "Recording
  spot-check outcomes".
- `Defect`: a spot-check outcome that is neither a pass nor a file-mode
  limitation. Fix it and re-run the spot check.

## Done condition

The manual pass is done when every listed criterion reads `Pass` in desktop
Firefox and in Safari on iOS, and the Edge and desktop Safari spot checks
each record `Pass` or `File-mode limitation`, with no `Defect`.
