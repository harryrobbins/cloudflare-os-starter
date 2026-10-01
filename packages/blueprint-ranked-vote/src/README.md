# Ranked Vote

A group choice decided by single transferable vote with one winner (instant-runoff). People propose options, fill in each option's fields, and privately drag every option into their own order. When every voter has clicked **Reveal**, the count runs and everyone sees the result round by round.

## How it works

- **Options.** Anyone can propose one. A new option goes to the bottom of every existing ballot, marked "new", and clears everyone's Reveal. That way nobody is counted before they have seen every option. Only the proposer can rename or delete an option. A rename counts as a new suggestion: the option moves to the bottom of everyone else's ballot, marked new, and every Reveal clears.
- **Fields.** Every option has a Description plus any fields people add, such as "Proposed URL", "Competition check" or "Companies House check". Each field is short text, long text or a web address. Anyone can fill them in.
- **Ballots.** Each voter ranks every option. Voters start from their own shuffled order, and their first move saves the ballot. A ballot is visible only to its owner, before and after the count.
- **Reveal.** Voters are the people who have saved a ballot. Clicking Reveal locks your order and undoing it unlocks it. When every voter has clicked Reveal, and there are at least the minimum number of voters (2 by default; set it to the group's size), the count runs and the vote closes. You can remove a colleague's ballot if it is not ready, for example when they are away. Removals are logged.
- **Count.** Each round, a ballot counts for its highest-ranked option still in the race. An option with more than half of those ballots wins. Otherwise the lowest option is eliminated and its ballots move on. Options with no votes are eliminated together. A tie for last place goes to the option that did worse in the most recent earlier round where they differed. If they were level in every round, lots are drawn, and the result says so.
- **Reopen.** Anyone can reopen after a count. Reveals clear, and ballots and earlier counts are kept.

## RPC surface

Agents: `describeBinding` shows this gadget's `describeGadget()`, the operations to call from `executeCode` with input schemas and runnable examples. Start with the convenience verbs.

Every write takes `by: {id, name}`, the signed-in account; the client always sends it. An agent may leave it out, and the write is then attributed to the **Assistant**. Anyone may rename or withdraw the Assistant's options. Writes resolve to `{revision, ...}`, or to `{error}` when the rules refuse, for example for a duplicate option. Wherever a write takes an option or a field, it accepts the id or the option's title or the field's label, ignoring case.

| Method | Args | Notes |
| --- | --- | --- |
| `setUpVote({by?, question?, fields?, options?, minVoters?})` | fields `[{label, kind?}]`; options titles or `{title, description?, values?}` | One validated write. Existing field labels are reused. Titles already on the list are skipped and returned in `skipped`. Values are keyed by field label or id |
| `proposeOptions({by?, options})` | as above | Adds options in one write |
| `fillInOption({by?, option, values, title?})` | option title or id; values by field label or id | Refuses unknown labels |
| `getResult()` | | Phase, voters, `waitingOn`, `votersNeeded` and the latest count by title, round by round. Never includes ballots |
| `getView(voterId)` | | Question, fields, options, voters with ready state, that voter's own ballot (`mine`), and results, newest first |
| `getSummaryMarkdown()` | | Options, fields, voters and every count. Never includes ballots |
| `setQuestion({by, question})` | | |
| `addField({by, label, kind})` | kind `text`, `long` or `url` | Returns `{field}` |
| `removeField({by, fieldId})` | | The Description field cannot be removed |
| `addOption({by, title, values?})` | values `{fieldId: text}` | Returns `{option}`. Only while voting is open |
| `updateOption({by, optionId, title?, values?})` | | Only the proposer can change the title |
| `withdrawOption({by, optionId})` | | Proposer only |
| `saveRanking({by, ranking})` | every option id exactly once | Creates or replaces the caller's ballot. Refused for the Assistant |
| `setReady({by, ready, ranking?})` | | Reveal. The last one runs the count. Refused for the Assistant |
| `removeBallot({by, voterId})` | account id or voter name | Your own ballot, or someone else's that is not ready |
| `setMinVoters({by, minVoters})` | 1 to 60 | The count waits for at least this many ballots |
| `reopen({by})` | | |
| `subscribe(target, {clientId, voterId})` | target has `update(view)` | Returns the view. Pushes a fresh view after every change |
| `ping(clientId, voterId)` / `unsubscribe(clientId)` | | Heartbeat and leave |

**Agents:** read with `getResult()` or `getSummaryMarkdown()`. You may set up the vote, propose options, fill in fields and remove the ballot of someone who is away when asked to. Never rank or click Reveal for anyone: those are each person's own vote, and the rules refuse them for the Assistant.

**Trust limits:** the server takes `by` from the caller. Secrecy and Reveal hold for honest clients, not against someone who tampers with their own browser.

## Adapting this gadget

**Files.** Read and edit only `client.js` and `server.js`. Never edit the `*.lib.js` files: they are generated bundles and are replaced whenever the gadget is rebuilt.

- `client.js`: the main view. It holds the `adapt` block, then the code that mounts the page.
- `client.lib.js`: the UI engine (sections, drag and drop, live sync, styles). The platform loads it before `client.js`.
- `server.js`: the `Gadget` class, which is the RPC surface, plus `describeGadget()` and the Markdown export.
- `server.lib.js`: the vote's rules, storage and live updates.
- `README.md`: this file.

**Use.** To read or change a vote, call its operations from `executeCode`. `describeGadget()` lists them: `setUpVote`, `proposeOptions`, `fillInOption`, `getResult`, `getSummaryMarkdown`, `setMinVoters`, `removeBallot`, `reopen`, `setQuestion`, `addField`, `removeField`, `withdrawOption`, then the low-level `getView`, `addOption` and `updateOption`.

**Adapt.** Most changes are edits to the `adapt` block at the top of `client.js`:

| Field | What it does |
| --- | --- |
| `title` | The page title |
| `labels` | Button and heading text: `reveal`, `undoReveal`, `propose` (the placeholder in the propose box), `ranking`, `results`, `fields`, `activity` |
| `layout` | `{main, side}`: which sections show, in which column and order. Built-in sections are `results`, `add` (the propose form), `ranking`, `ready` (Reveal and voters), `fields` and `activity`. Leave a name out to hide that section |
| `panels` | Extra sections, as `name: (app) => Node \| string \| array`. A panel is redrawn after every change, and you add its name to `layout` to show it. Build nodes with `h(tag, props, children)`. Props take `class`, `text`, `on<event>` handlers and attributes |
| `showRoundTable`, `showRoundStory` | Show the results table (one column per round) and the round-by-round explanation |
| `styles` | Extra CSS, applied after the built-in styles. The colours are CSS variables such as `--accent`, `--win` and `--surface` |
| `actions` | Extra commands, as `{id, label, title?, run(app)}`. They show as buttons in a toolbar under the question, in keyboard order. `run` may be async, and an error it throws shows as a message |
| `onReady(app)` | Called once, when the first view has arrived |

The library checks the block. It ignores unknown keys, and it reports a bad action, panel or layout name in the console and skips it instead of failing.

**The `app` handle**, passed to actions, panels and `onReady`:

| Member | What it does |
| --- | --- |
| `app.me` | The signed-in account `{id, name}`. Every write is attributed to it |
| `app.view` | The current view: `question`, `phase`, `minVoters`, `fields`, `options` (`{id, title, values, by}`), `voters`, `mine` (this viewer's ballot), `results` (newest first) and `activity`. It is `null` before the first view arrives |
| `app.getResult()`, `app.getSummaryMarkdown()` | The server reads described under **Use** |
| `app.setUpVote(args)`, `app.proposeOptions(options)`, `app.proposeOption(title, values?)`, `app.fillInOption(option, values)`, `app.setQuestion(q)`, `app.addField(label, kind?)`, `app.setMinVoters(n)`, `app.reopen()` | Writes, as this viewer. A refusal shows as a message, and the promise rejects |
| `app.moveOption(option, position)` | Moves an option (title or id) to a 1-based position in this viewer's own ranking |
| `app.reveal()`, `app.undoReveal()` | This viewer's own Reveal, using their current order |
| `app.toast(text)` | Shows a short message |
| `app.render()` | Redraws every section |
| `app.call(method, args?)` | Calls any `Gadget` method, with `by` added |

To change a rule or add a server operation, add a method to `class Gadget` in `server.js`. `this.service.write(rule, args)` runs one of the vote's rules (`setUp`, `addOption`, `updateOption`, `withdrawOption`, `setMinVoters`, `removeBallot`, `reopen` and the rest), saves it and pushes fresh views to everyone. `this.service.result()` and `this.service.view(voterId)` read. If you add an operation for agents, add it to `describeGadget()` too.

### Worked examples

Use: set up a vote from a request, then check on it.

```js
await env.Vote.setUpVote({
  question: "What should we call the new company?",
  fields: [{ label: "Proposed URL", kind: "url" }],
  options: [{ title: "Hoarse", values: { "Proposed URL": "hoarse.co.uk" } }, "Lumen", "Tessel"],
  minVoters: 4,
});
const { waitingOn, votersNeeded, latestCount } = await env.Vote.getResult();
```

Adapt: add a button that says who the vote is waiting on, and a panel that counts the options. Edit the `adapt` block in `client.js`:

```js
  panels: {
    tally: (app) => h("p", { text: `${app.view.options.length} options so far` }),
  },
  // …and add "tally" to layout.side
  actions: [
    { id: "waiting", label: "Who are we waiting on?", run: async (app) => {
      const r = await app.getResult();
      app.toast(r.waitingOn.length ? `Waiting on ${r.waitingOn.join(", ")}` : "Nobody: everyone is ready");
    } },
  ],
```

Edits to a gadget made from this blueprint change only that copy. They are not carried back to the blueprint (`packages/blueprint-ranked-vote`).

### Eval runs

