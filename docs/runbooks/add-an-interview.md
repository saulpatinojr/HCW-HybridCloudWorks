# Add an interview

> **Status: in use.** The Interviews pages went in on 2026-10-24 (the
> changelog has the entry). **The only interview is a sample.**
> `frontend/src/data/interviews/example-interview.json` has a made-up guest and
> says so on the page; it is there so the pages show up and so you have a real
> file to copy. Copy it to a new name, write the real interview, and **delete
> the sample** when the first real one goes live. With no interview file at all,
> the Azure landing page has no Interviews card and the sitemap has no
> Interviews page, on purpose.

**Scope:** how to publish one interview on the Azure section, at
`/azure/interviews/<name>`. An interview is one text file. You do not edit any
code or any list.

**Authority:** this page does not change anything by itself. The steps that do
(merging a change, deploying the site) are the owner's.

## What you get

For each interview file the site builds:

- **An article page** that holds the whole interview as plain text. This is the
  version search engines read, what a phone shows, and what a screen reader
  reads. It also gets a title, a description and an *Article* record for search
  results.
- **A "Book view"** for visitors on a wide screen who have not asked their
  device for less motion. It lays the same words out as pages that turn. It is
  an extra: the article is always there, and nothing is lost if the book is not
  offered.
- **A card on the list page** at `/azure/interviews`, newest first.

## The file

Put one file in `frontend/src/data/interviews/`. Its name is the web address, so
it must be lower-case words joined by hyphens, for example
`azure-landing-zones-2026.json` gives `/azure/interviews/azure-landing-zones-2026`.

A name that starts with an underscore, such as `_azure-landing-zones-2026.json`,
is a **draft**: the site ignores it, so you can keep unfinished work in the
folder. Remove the underscore to publish.

This is the format. The guest, the words and the links below are **made up** to
show the shape; they are not a real interview:

```json
{
  "title": "Landing zones in the real world",
  "subtitle": "A conversation about running them for years, not weeks",
  "date": "2026-10-01",
  "guest": { "name": "Example Guest", "role": "Principal Cloud Architect" },
  "bio": "Two or three sentences about the guest.",
  "image": { "src": "/images/interviews/example-guest.jpg", "alt": "Example Guest smiling at a desk" },
  "tags": ["landing-zones", "governance"],
  "qa": [
    {
      "q": "What is the most common landing zone mistake?",
      "a": "The answer, as long as it needs to be. A blank line starts a new paragraph.",
      "pullQuote": "A short line from this answer to show large (optional)."
    },
    { "q": "The next question?", "a": "Its answer." }
  ],
  "related": {
    "labs": [{ "title": "A lab on this site", "url": "/azure/education/labs" }],
    "learn": [{ "title": "A Microsoft Learn page", "url": "https://learn.microsoft.com/azure/cloud-adoption-framework/" }]
  }
}
```

### What each part needs

| Part | Rule |
| --- | --- |
| `title` | Required. Up to 160 characters. |
| `date` | Required. Written `YYYY-MM-DD`, and a real date. |
| `guest.name` | Required. `guest.role` is optional. |
| `qa` | Required: 1 to 40 questions. Each has `q` and `a`; `pullQuote` is optional. An answer can be up to 6000 characters. |
| `subtitle`, `bio` | Optional. |
| `image` | Optional. If you give a picture you **must** give `alt`, a short description of what it shows, so a screen reader can say it. |
| `tags` | Optional. Lower-case words joined by hyphens. |
| `related.labs`, `related.learn` | Optional lists of up to 12 links, each with a `title` and a `url`. |

Two rules about links and pictures, and the build refuses a file that breaks them:

- A link is either an address on this site (it starts with a single `/`) or an
  `https://` address. `http://`, `javascript:` and other forms are refused.
- Put the picture in `frontend/public/images/interviews/` and point `src` at it,
  as in the example. A picture from another website can fail the build's image
  check, which only allows hosts the site's security policy names
  (`frontend/scripts/check-image-hosts.mjs`).

Everything you type is shown as plain text, so a `<` in an answer appears as a
`<`. There is no bold or italic; a blank line makes a paragraph and nothing
else is formatted.

## Publish it

1. **Write the file** in `frontend/src/data/interviews/` as above, with a name
   that starts with an underscore while you work on it.
2. **Check it** from the repository root, in PowerShell:

   ```powershell
   cd frontend; npm test -- src/data/interviews
   ```

   You should see `passed` and no `failed`. If a file is wrong, the message names
   the file and the field, for example
   `azure-landing-zones-2026.json: date must be a date written YYYY-MM-DD.`
   Fix that and run it again. (A file starting with an underscore is not checked
   until you remove the underscore.)
3. **Remove the underscore** from the file name, run step 2 again, and open a
   pull request. The pull request's checks run the same test and a full build.
4. **After it is merged, deploy the site.** The website is deployed by hand, so
   nothing is live until this runs. Start it with:

   ```powershell
   gh workflow run deploy-azure-frontend.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
   ```

   You should see `Created workflow_dispatch event for deploy-azure-frontend.yml at main`.
   Watch it at
   [the Deploy Frontend runs](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-azure-frontend.yml);
   it should finish green. Merging a change under `frontend/` also starts a
   clock on the delivery monitor, which goes red if the deploy has not run
   within about 8 hours.
5. **Look at it.** Open `https://hybridcloudworks.com/azure/interviews`. You
   should see your interview's card and, on its page, the article. On a wide
   screen a **Book view** button appears above it. The Azure landing page,
   `https://hybridcloudworks.com/azure`, now has an **Interviews** section with
   an **All interviews** link.

## What to expect, and what to check if it is wrong

- **The first interview adds three things at once:** the Interviews section on
  the Azure landing page, the list page, and the interview's own page. All three
  appear on the next deploy. With no interview file none of them exist.
- **There is no Interviews link in the top menu, on purpose.** The menu is a
  fixed row of nine slots with a divider whose position must be the same on
  every provider, and a tenth link overflowed it on a normal laptop screen. The
  pages still keep the Azure menu while you read them.
- **The Book view button is missing on your laptop.** That is by design if the
  window is narrower than 768 pixels, or if the device is set to reduce motion.
  The article is the page either way.
- **A build fails with a sentence about a file.** The sentence names the file
  and the field. It is always a fix in the interview file.
- **Search engines.** The article pages are in the sitemap on the next deploy.
  How soon they appear in search results is up to the search engine and cannot
  be checked here.

## How it works, for whoever changes the code

- `frontend/src/lib/interviews.js` holds the format, its checks and how an
  interview becomes the book's pages. `normalizeInterview` is what both the
  build and the tests call, so they cannot disagree about what is valid.
- `frontend/src/data/interviews/index.js` reads the files at build time.
  `available.js` reads only the file *names*, so the Azure landing page can decide
  whether to show its Interviews card without putting every interview's text in
  its bundle.
- `frontend/src/pages/azure/InterviewsPage.jsx` is the page. The article is
  rendered first and is what is pre-rendered; the book is chosen by the visitor
  after the page has loaded, and its code is fetched only then.
- `frontend/scripts/prerender-entry.jsx` lists the interview routes **only when
  there is at least one**: an empty list page in the sitemap would be thin
  content.
- The book is built with CSS in this repository, with no library. The usual
  flip-book package was last released in April 2021 (owner decision,
  2026-10-24).
- The book's pages use a fixed paper colour and fixed text and link colours,
  not the site's theme classes, because the theme rewrites `bg-white` inside a
  provider page and the dark theme made the pages unreadable.
