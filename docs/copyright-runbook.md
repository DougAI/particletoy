# Copyright runbook

What to actually do when a DMCA notice arrives, and the policy it applies.

This exists because §512(i) makes the safe harbor conditional on the
repeat-infringer policy published on [dmca.html](../dmca.html) being *reasonably
implemented* — not merely published. The case people lose on is not a lenient
policy; it is a policy that was ignored. **A generous rule you follow beats a
strict one you don't.** So the rule below is deliberately simple enough to
follow on a bad week.

Nothing here is legal advice. It was drafted by a non-lawyer and should be read
by one.

---

## 0. The policy

Everything else in this file is mechanical. These three are judgement — and
having been decided, the only thing that matters is that they stay the same
from one notice to the next. Change them deliberately or not at all.

| | |
|---|---|
| Strikes before the account is suspended | **3** |
| Window they're counted over | **12 months, rolling** |
| What clears a strike | a successful counter-notice, or a withdrawn notice |

Two rules that hold whatever those numbers are:

- **Re-uploading material that was removed is a strike on its own**, immediately.
- **A notice is not a strike until you decide it's a good one.** That's why
  `counts_as_strike` defaults to `false` — a notice cannon shouldn't be able to
  terminate an account without a human agreeing with it.

## 1. Intake

Notices reach the designated agent — Registered Agents Inc,
`support@registeredagentsinc.com` — who forward them. **The §512 clock starts
when they receive it, not when you read the forward**, so the forwarding path
needs to work and needs checking. Test it, and re-test it whenever RAI changes
anything.

Act the same day where you can. "Expeditiously" has no fixed definition, but it
is measured from their receipt.

## 2. A notice arrives

**a. Check it's actually a notice.** All six elements of §512(c)(3)(A) — they're
listed on [dmca.html](../dmca.html). Missing elements mean you're not obliged to
act on it; if it's close, ask the sender for the missing piece rather than
ignoring it. Log it either way (step c).

**b. Remove the material.** In Supabase → SQL Editor, which runs as the service
role. `takedown_at` is in no column grant, so this is the only way it can be
set — and the only reason a takedown sticks:

```sql
update public.particles
   set takedown_at = now(),
       takedown_ref = '<your notice reference>'
 where id = '<particle-uuid>';
```

The particle immediately stops being readable by anyone but its owner — that
covers the gallery, search, the view page, its comments, and the link-preview
card, which reads the database as `anon`.

**c. Delete the stored media. This step is not optional.** The `media` bucket is
publicly readable by URL, so hiding the row leaves the thumbnail and preview
clip being served — and those exact URLs are baked into every link-preview card
already shared. In Supabase → Storage → `media`, delete:

```
<owner-uuid>/thumbs/<particle-uuid>.jpg
<owner-uuid>/previews/<particle-uuid>.<mp4|webm|gif>
```

Get `<owner-uuid>` from `select owner from public.particles where id = '…'`.

**d. Log it.** This row is the evidence that the policy is real, and it is
written to outlive both the particle and the account — so copy the title and
username in rather than relying on the join:

```sql
insert into public.copyright_notices
  (particle_id, particle_title, owner_id, owner_username,
   claimant, claimant_contact, outcome, counts_as_strike, actioned_at, notes)
select p.id, p.title, p.owner, pr.username,
       '<claimant>', '<their email>', 'removed', true, now(), '<anything useful>'
  from public.particles p
  join public.profiles pr on pr.id = p.owner
 where p.id = '<particle-uuid>';
```

Set `outcome` to `rejected` instead, with `counts_as_strike = false`, if you
decided the notice was defective and did nothing.

**e. Tell the user.** What was removed, why, a copy of the notice including the
claimant's contact details, and a pointer to the counter-notice route on
[dmca.html](../dmca.html). Passing the notice on is what makes the counter-notice
route usable, and it's what dmca.html promises.

## 3. A counter-notice arrives

**a. Check the four elements** of §512(g)(3) — on dmca.html.

**b. Log it** as `kind = 'counter'`.

**c. Forward it to the original claimant** and tell them the material may be
restored in 10 business days unless they tell you they've filed a court action.

**d. Wait.** Restore between 10 and 14 business days after receipt if nothing
arrives:

```sql
update public.particles set takedown_at = null, takedown_ref = null
 where id = '<particle-uuid>';

update public.copyright_notices
   set outcome = 'restored', counts_as_strike = false
 where particle_id = '<particle-uuid>' and kind = 'notice';
```

The media files are gone from storage and won't come back — the owner has to
re-render the preview from the particle's page.

## 4. Counting strikes

```sql
select owner_username, owner_id, count(*) as strikes, max(received_at) as latest
  from public.copyright_notices
 where counts_as_strike
   and received_at > now() - interval '12 months'
 group by owner_username, owner_id
 order by strikes desc;
```

Run it after every notice. That's the whole of "tracking".

## 5. Suspending an account

At the threshold from §0, and only there — consistency is the point:

```sql
update public.profiles set suspended_at = now() where id = '<user-uuid>';
```

That stops them publishing and commenting. It does **not** stop them signing in
or reading — for a full termination also ban the user in
**Supabase → Authentication → Users**, which is the lever that actually ends
access.

Tell them, and say what would need to happen to reverse it. `suspended_at = null`
lifts the app-level half.

## 6. Never

- **Never delete rows from `copyright_notices`.** They are the record that the
  policy was applied consistently. They're cheap; keep them forever.
- **Never let the inbox go unwatched.** "We never saw it" is not a defense, and
  the clock runs from the agent's receipt.
- **Never strike an account for a notice you didn't uphold**, and never skip a
  strike for a user you like. Inconsistency is the failure mode that costs the
  safe harbor.

## 7. When to build tooling

Doing all of this by hand is a perfectly reasonable implementation at this size,
and hand-execution against a written runbook is exactly what "reasonably
implemented" asks for. Build admin UI when the manual path starts costing
mistakes — realistically, somewhere around the third or fourth notice, or the
first time two arrive in a week. The thing most worth having then is a pair of
security-definer RPCs for takedown and restore, so the steps of §2 can't be
half-done: today nothing stops the row being flagged and the storage objects
being left behind, which is the failure that leaves infringing material served
from a URL while the site believes it is gone.

(The owner-facing half is already built: a removed particle carries a *removed*
badge in its owner's list and an explanation on its page, pointing at the
counter-notice route. Nobody else can see it at all.)
