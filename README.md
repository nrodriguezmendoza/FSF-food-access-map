# FSF Food Access Map

A planning tool for **Feeding South Florida** that finds the neighborhoods its partner network
doesn't reach.

**Live:** https://fsf-food-access-map.vercel.app/map

![Census tracts across South Florida shaded by need score, with partner agency
coverage circles overlaid and a ranked list of uncovered high-need tracts in the
left panel](docs/map-screenshot.png)

## Why FSF needed this

Feeding South Florida distributes food across Miami-Dade, Broward, Palm Beach, and Monroe counties,
and it does so almost entirely through partner agencies: the churches, pantries, and community
groups that hand food directly to people. Partner placement therefore determines who gets reached.

County-level statistics hide the gaps. Aggregate numbers can show that a county is well served
while saying nothing about the six blocks with the highest poverty rate in that county having no
partner agency within two miles.

The decision this tool was built for is narrower still. FSF receives more applications from
community groups wanting to become partner agencies than it has capacity to onboard. Choosing among
them previously meant weighing each application largely on its own merits, with no clear view of
which ones would close a real hole in coverage. The map answers that question directly. It scores
every census tract for need, plots the existing partner network on top, and ranks the high-need
tracts that nobody currently covers.

> "Our Director of Partner Relations and I spent some time looking at the great work. We love it!
> It is super informative to us and will help us when we evaluate our backlog of community groups
> who have applied to become partner agencies."
>
> Chief Operating Officer, Feeding South Florida

## How it works

### The need score

Every census tract receives a score from 0 to 100, built from seven federal indicators:

| Indicator | Weight | Source |
|---|---|---|
| Poverty rate | 25% | Census ACS `B17001` |
| Food desert | 18% | USDA Food Access Research Atlas |
| SNAP enrollment | 15% | Census ACS `B22010` |
| No vehicle access | 12% | Census ACS `B25044` |
| Median income (inverted) | 10% | Census ACS `B19013` |
| Unemployment | 10% | Census ACS `B23025` |
| Housing cost burden | 10% | Census ACS `B25106` |

Raw rates cannot be combined directly, since a 30% poverty rate and a $38,000 median income do not
sit on the same scale. Each indicator is percentile-rank normalized first, so a tract's value
becomes its position relative to every other tract. The CDC uses this method for its Social
Vulnerability Index. It resists outliers, which matters here: without it, a single extreme tract
would compress every other value into a narrow band.

Tracts numbered 9800 to 9999 are excluded from scoring. The Census reserves that range for
institutional group quarters such as prisons, dormitories, barracks, and airports. Poverty and SNAP
rates in those tracts are accurate but describe an institution rather than a neighborhood, and
placing a partner agency there would serve no one.

The weights above are a starting point rather than a fixed formula. Staff can adjust them in the
interface and the map re-scores as they move, which makes it possible to ask what the picture looks
like when transportation access matters more than income.

### Coverage gap analysis

The map draws a service radius around each of FSF's roughly 199 partner agencies, then lists every
high-need tract whose center falls outside all of them, worst first. The radius is adjustable, so
narrowing it to a one-mile walk re-ranks the list immediately.

That ranked list is the working output. It is the shortlist of places where a new partner agency
would do the most good.

## Scale and stack

The map covers 1,526 census tracts across four counties: Miami-Dade (707), Broward (417), Palm
Beach (373), and Monroe (29). Each tract is scored against four ACS vintages, 2021 through 2024.

The frontend is React and MapLibre GL, deployed on Vercel. The backend is FastAPI on Render, backed
by Supabase Postgres, which pulls from the Census API and computes the stored scores.

One design decision shapes how the tool feels to use. Need scores are recomputed in the browser
rather than in the database, so moving a weight slider re-scores all 1,526 tracts and repaints the
map without a request to the server.

## Repository

- `frontend/` contains the React app. `src/pages/HealthMap.jsx` holds the map, the scoring, and the
  gap analysis.
- `backend/` contains the FastAPI service, the Census and USDA data pipeline, and `scoring.py`,
  which is the shared definition of both scores.
