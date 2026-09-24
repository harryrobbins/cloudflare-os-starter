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

Every write takes `by: {id, name}`, the signed-in account. Writes resolve to `{revision, ...}`, or to `{error}` when the rules refuse, for example for a duplicate option.

| Method | Args | Notes |
| --- | --- | --- |
| `getView(voterId)` | | Question, fields, options, voters with ready state, that voter's own ballot (`mine`), and results, newest first |
| `getSummaryMarkdown()` | | Options, fields, voters and every count. Never includes ballots |
| `setQuestion({by, question})` | | |
| `addField({by, label, kind})` | kind `text`, `long` or `url` | Returns `{field}` |
| `removeField({by, fieldId})` | | The Description field cannot be removed |
| `addOption({by, title, values?})` | values `{fieldId: text}` | Returns `{option}`. Only while voting is open |
| `updateOption({by, optionId, title?, values?})` | | Only the proposer can change the title |
| `withdrawOption({by, optionId})` | | Proposer only |
| `saveRanking({by, ranking})` | every option id exactly once | Creates or replaces the caller's ballot |
| `setReady({by, ready, ranking?})` | | Reveal. The last one runs the count |
| `removeBallot({by, voterId})` | | Your own ballot, or someone else's that is not ready |
| `setMinVoters({by, minVoters})` | 1 to 60 | The count waits for at least this many ballots |
| `reopen({by})` | | |
| `subscribe(target, {clientId, voterId})` | target has `update(view)` | Returns the view. Pushes a fresh view after every change |
| `ping(clientId, voterId)` / `unsubscribe(clientId)` | | Heartbeat and leave |

**Agents:** read with `getSummaryMarkdown()`. You may propose options and fill in fields for the user. Never save a ranking or click Reveal for someone. Those are the person's own vote.

**Trust limits:** the server takes `by` from the caller. Secrecy and Reveal hold for honest clients, not against someone who tampers with their own browser.
