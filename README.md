# Supermarket List

A small self-hosted shopping list, built to be used with one hand while walking
around the supermarket. Check items off as you drop them in the cart, watch the
running total, and keep every device in sync.

![Screenshot](image1.png?raw=true "Example")

## Running it

With Docker (how it runs at home):

```bash
docker compose up -d
```

The image only carries Python and the dependencies; `app/` is mounted into the
container, so the code, `sqlite.db` and `.secret_key` stay in the repository
folder and survive rebuilds. Code changes need a `docker compose restart`, not a
rebuild. The user commands below run inside it the same way:

```bash
docker compose exec supermarketlist python app/main.py --add-user someone-else
```

Or straight from Python:

```bash
pip install -r requirements.txt
python app/main.py
```

Either way, open <http://localhost:8989>. On first run the app creates
`app/sqlite.db` and a default user, `admin@admin` / `admin` — change it right
away:

```bash
python app/main.py --set-password admin@admin
python app/main.py --add-user someone-else
python app/main.py --add-user an-admin --admin
```

The default user is an admin. Admins can add, rename, delete and promote other
users, and reset their passwords, straight from the account menu in the top
right — no command line needed. Every user can change their own username and
password from the same menu.

Drop a `certificates/` folder with `cert.pem` and `key.pem` next to `app/` and
the server starts on HTTPS port 443 instead.

### Settings

| Variable               | Default         | Meaning                                   |
| ---------------------- | --------------- | ----------------------------------------- |
| `PORT`                 | `8989`          | Port to listen on                         |
| `HOST`                 | `0.0.0.0`       | Interface to bind                         |
| `SUPERMARKET_DB`       | `app/sqlite.db` | Database file                             |
| `SUPERMARKET_CURRENCY` | `BRL`           | ISO currency code used for formatting     |
| `SUPERMARKET_LOCALE`   | `pt-BR`         | Locale used for formatting                |
| `DEBUG`                | unset           | Set to enable the reloader and tracebacks |

## What it does

- **Check things off.** Tap the box as you put something in the cart. The card
  shows what is already in the cart, what is still to get, and the total.
- **Several lists.** Switch between them from the chips at the top; rename,
  duplicate, delete or drag them into the order you want.
- **Suggestions.** Typing an item name suggests from your own history (most-used
  first) and from a large built-in grocery catalogue in English and Portuguese.
  Accents and case are ignored, so `acai` finds `Açaí`; the catalogue is cached by
  the service worker, so suggestions work with no signal inside the store.
- **Shared lists.** A list can be shared with other users, who see and edit it
  live. Admins can share any list; other users need the "can share" permission.
- **Edit in place.** Name, quantity and price are editable fields; the line
  total and the list totals update as you type. Quantities can be fractional
  (`0.5` kg of cheese).
- **Undo.** Deleting an item offers an undo for a few seconds. Swipe a row left
  on a phone to delete it.
- **Reorder.** Drag the handle on the left to put the list in aisle order.
- **Search.** Filter a long list from the magnifier (or press `/`).
- **Export.** Copy the list as text or download it as CSV.
- **Accounts and roles.** Each user has their own lists. Admins manage other
  users from the account menu — create, rename, reset passwords, promote, grant
  sharing, see a user's lists and their last sign-ins, and sign them out of every
  device. Anyone can update their own username and password.
- **Live sync.** Every device long-polls `/api/version`, so a change made on
  your phone shows up on the kitchen tablet within milliseconds — no page
  reloads, and nothing you are typing gets overwritten.
- **Installable.** It ships a web app manifest and a service worker, so it can
  be added to a phone's home screen and opens as a standalone app.
- **Light and dark.** Follows the system theme, with a manual toggle.

There are no CDN dependencies: no jQuery, no Bootstrap, no icon fonts. The page
is one stylesheet, one script and an inline SVG sprite, so it loads instantly
on a phone with bad supermarket reception.

## Layout

```
Dockerfile, docker-compose.yml
app/
  main.py        Flask app, JSON API and the command line
  auth.py        Session + HTTP Basic authentication
  database.py    SQLite access, schema and migrations
  models.py      Plain data objects
  content/       index.jinja2, login.jinja2, custom.css, script.js, sw.js, icon.svg
```

The database is created and migrated on start-up, so an existing `sqlite.db`
from an older version keeps working — it just gains the new columns.

## API

Everything under `/api` takes and returns JSON and requires authentication
(session cookie, or HTTP Basic for scripts).

| Method           | Path                            | Purpose                    |
| ---------------- | ------------------------------- | -------------------------- |
| `GET`            | `/api/state`                    | Every list with its items  |
| `GET`            | `/api/version?since=N&wait=25`  | Long-poll for changes      |
| `POST`           | `/api/lists`                    | Create a list              |
| `POST`           | `/api/lists/reorder`            | Reorder lists              |
| `PATCH`/`DELETE` | `/api/lists/<id>`               | Rename / delete a list     |
| `POST`           | `/api/lists/<id>/duplicate`     | Copy a list                |
| `POST`           | `/api/lists/<id>/items`         | Add an item                |
| `POST`           | `/api/lists/<id>/items/reorder` | Reorder items              |
| `POST`/`DELETE`  | `/api/lists/<id>/checked`       | Check all / remove checked |
| `PATCH`/`DELETE` | `/api/items/<id>`               | Edit / delete an item      |
| `GET`            | `/api/share-targets`            | Users a list can go to     |
| `GET`/`POST`     | `/api/lists/<id>/shares`        | List / add shares          |
| `DELETE`         | `/api/lists/<id>/shares/<uid>`  | Stop sharing with a user   |
| `POST`           | `/api/account/username`         | Change your own username   |
| `POST`           | `/api/account/password`         | Change your own password   |
| `GET`/`POST`     | `/api/users`                    | List / create users (admin)|
| `PATCH`/`DELETE` | `/api/users/<id>`               | Edit / delete a user (admin)|
| `GET`            | `/api/users/<id>/lists`         | A user's lists (admin)     |
| `GET`            | `/api/users/<id>/logins`        | Recent sign-ins (admin)    |
| `POST`           | `/api/users/<id>/logout`        | Sign a user out (admin)    |

Every list and item query is scoped to the lists the signed-in user owns or has
been shared, so ids belonging to somebody else return 404. The `/api/users` routes require an admin account.

> The built-in server is Flask's development server — fine on a home network,
> but put it behind a real WSGI server if you expose it to the internet.
