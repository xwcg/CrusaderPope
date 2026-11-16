# Writing the script database's explanations

Every entry a user can pick in CrusaderPope (a CK3 mod editor) gets an explanation, so nobody has to guess what a
script key does. The owner's words: "everything a user picks to be explained so no guessing is needed. In clear and
easy to understand language. That means also explaining what the effects entail."

Readers: CK3 modders, from beginners who have never written script to experienced ones. They see the explanation in a
menu row, in a help box next to the menu, and as a tooltip in the readable view of the script.

## Input and output

An input file (`data/script-db/work/input/<kind>-<nnn>.json`) is an array of entries:
- `kind`, `key`, `variant` (copy them exactly);
- `doc`: the game's own documentation text (from its `script_docs` / `dump_data_types` console commands; may be
  terse, may have typos, may be empty);
- `scope` / `target` / `input` / `output` / `area` / `root`: scope types (where it runs, what it takes, what a link
  gives, a modifier's use areas, an on_action's root);
- `facts`: kind-specific facts (a list's forms and their docs, a link's `requiresData`/`global`, an on_action's
  `fromCode`, a function's `type`, `args`, `returnType`, `description` …);
- `vanilla`: how the base game's own script uses it (counts, value shapes, common values, block fields with their
  values, short examples; an on_action's definition text; a function's count of uses in the game's texts);
- `info` (saved scopes, on_actions): the game's own notes from its `.info` files, each `path:line: <up to 3 lines
  above> / <the line>`; they say which scopes the game's code gives where (`scope:travel_speed - Travel Speed …
  Only set when building the tooltip`). Strong evidence: cite as `"vanilla: <path>:<line>"`. A generic name (`target`,
  `province`) is given in many places with different meanings: say so, with the notes as examples;
- `gameConcept` (global data functions): the game concept the function is (`common/game_concepts`: every concept and
  its aliases are global functions, the ones a text's `[retreat|E]` calls), with the concept's name and description
  texts; explain it as that concept (what the concept is, from its description in our own words, and that
  `[key|E]` in a text shows the word linked to the concept's explanation);
- `app`: the app's own current label/help where it has one (keep consistent with it unless it is wrong);
- for modifiers `loc` / `locDesc`: the game's own display name / description (`[prestige|E]` is a game concept link,
  read it as the word "prestige").

The output file (`data/script-db/explanations/<kind>-<nnn>.json`, same name as the input) is a JSON array with one
object per input entry, in the same order:

```json
{
  "kind": "effect",
  "key": "add_gold",
  "label": "Gold",
  "summary": "Gives the character gold, or takes it away with a negative amount.",
  "details": "The amount can be a number or a script value. Taking more than they have leaves them in debt.",
  "fields": [{ "name": "value", "text": "How much gold.", "values": "a number or a script value", "required": true }],
  "sources": ["doc", "vanilla"],
  "uncertain": false
}
```

- `variant`: only when the input has one.
- `label`: 1–5 words, sentence case, menu-ready, no script key in it ("Gold", "Liege", "Is adult", "First name").
  Effects: the thing they act on or the action ("Gold", "Imprison"); triggers: the condition ("Is adult",
  "Has trait"); lists: the item in the singular ("Vassal", "Held title"); links: what they lead to ("Liege",
  "Primary title"); functions: what they return ("First name").
- `summary`: one sentence, what it does / checks / is / returns, in plain words.
  Effects start with a verb ("Gives …", "Removes …", "Makes …"); triggers with "Whether …" ("Whether the character
  is an adult."); lists with "Each …" / "Every …" ("Each direct vassal of the character."); links with "The …" ("The
  character's liege."); functions with what they return ("The character's first name.").
- `details`: what it entails, 0–5 short sentences: consequences (who gains or loses what, what else changes),
  defaults when something is left out, where it works (in plain words: "on a character", "on a title"), limits and
  gotchas the input states, how it differs from a similar key when the doc says so. Empty string when there is
  nothing beyond the summary. Not a repetition of the summary.
- `fields`: the parameters of a block form or a list (from the doc's usage lines and the vanilla fields): `name`,
  `text` (meaning), `values` (what can be written there), `required` (only when known), `default` (only when known).
  Empty array when it takes a single value or nothing.
- `sources`: `"doc"`, `"vanilla"` (the usage given in the input), and `"vanilla: <path>:<line>"` for a file you read.
- `uncertain`: true when the input does not let you say what it does with confidence (no doc, little or no vanilla
  use, an unclear doc). Then the summary says only what is known ("A game function of the GUI; the game documents
  nothing more.") — never a guess presented as fact.

## Rules

- **No guessing.** Every statement must be backed by the input (doc, facts, vanilla) or by a vanilla file you read
  (`D:\SteamLibrary\steamapps\common\Crusader Kings III\game`, read only; cite it in `sources`). If you infer
  something from vanilla's use, say so ("Vanilla uses it to …").
- **Our own words.** Explain; do not copy the game's doc sentences. Fix nothing silently: if the doc contradicts
  vanilla, say what vanilla does and set `uncertain`. In the texts, the doc is "the game's documentation" ("the
  documented example"), never "the doc": the reader does not know our input.
- **Plain language.** Short sentences, present tense, everyday words. Explain game terms the first time they matter
  ("county control (how firmly the holder controls the county)"). Script words in backticks only when the user
  needs to write them (`yes`, `days = 5`). No "scope" jargon in summaries: say "the character", "the title".
- **Direction and who is who.** Say plainly who gives and who receives, who is checked against whom
  (`has_relation_guardian = X`: "Whether X is the character's guardian").
- **Numbers and units.** `_add` modifiers add a flat amount, `_mult` ones a percentage; durations in days, months or
  years as written; say when a value can be negative.
- **Kind notes**
  - list: one explanation for all its forms (`every_` / `random_` / `ordered_` effects, `any_` trigger); say what the
    items are and whose; parameters (`type = …`, filters) as fields.
  - link: from what to what; a link that takes data (`requiresData`, written `name:key`) explains what the key is.
  - saved_scope: what the game's code saves under `scope:<name>` and in which situations, from the vanilla uses
    given; `uncertain` when that depends on the situation and the input does not show it.
  - scope_type: what the thing is in the game and what script can do with it.
  - modifier: what it changes, by how much per point (flat or percent), on whom (its areas). A template tag
    (`$TERRAIN_TYPE$_supply_limit`) says what `$X$` stands for and gives one example key.
  - on_action: when the game fires it (`fromCode`: the game's code fires it; otherwise script fires it), what it
    is about (root), what vanilla does in it, briefly.
  - custom_loc: what text it produces, from its entries.
  - data_type / data_function: what it is / returns, short. Most have no description of their own; then explain from
    the evidence the input gives: the type it belongs to (`CharacterWindow` = the character window of the game's
    interface), its return type, its name, and the lines that use it: `vanilla.linesWithThisFunction` (game texts and
    GUI files, the engine's `jomini/` ones too, that use this very function: written out as `Type.Function`, or
    reached through a chain step by step by return type, `[GetPlayer.GetPrimaryTitle.GetName]`; evidence for this
    function), `vanilla.chainUses` (how many uses the chains reach), `vanilla.linesWithSameNameAnyType` (lines
    where the same function name follows something else; it may belong to another type: a hint at most, never
    evidence) and `vanilla.usesOfNameAnyType` (how often the name appears, all types together). Say when the
    explanation rests on the name and such uses ("Going by its name and its use in the character window, …") and set
    `uncertain` then; `uncertain` alone, with "The game documents nothing more", only when even the name and the uses
    say nothing.
- **Write every entry yourself**, one by one. Do not generate the texts with a script or a template that fills in
  the name: a label made by splitting the name into words, or the same sentence for every entry, is not an
  explanation.
- **Valid JSON** (UTF-8, no comments, no trailing commas); one object per input entry, same order, `kind`/`key`/
  `variant` unchanged.
