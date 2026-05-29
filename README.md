# BitEagle News Poller

Polls `flash.biteagle.xyz` fast-news records and pushes new items to a Telegram chat or forum topic.

## Features

- Polls `https://flash.biteagle.xyz/api/news?id=latest`
- Fills gaps by fetching missing numeric news ids
- Stores pulled records in `data/news.jsonl`
- Sends Telegram messages with a clean format
- Supports Telegram forum topics through `message_thread_id`
- Includes a source-discovery helper for historical `source` host scanning

## Configuration

Use environment variables or create a local `bot.txt` file. Do not commit `bot.txt`.

```text
TELEGRAM_BOT_TOKEN=123456:replace_me
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_MESSAGE_THREAD_ID=2716
TELEGRAM_PROXY=http://127.0.0.1:7890
```

`TELEGRAM_PROXY` is optional. Leave it empty on a server that can reach Telegram directly.

## Run Once

```bash
node biteagle_news_feed.mjs --mode once --backfill 30
```

## Run With Telegram Push

```bash
node biteagle_news_feed.mjs \
  --mode poll \
  --interval-ms 15000 \
  --backfill 30 \
  --telegram
```

To override the Telegram target from the command line:

```bash
node biteagle_news_feed.mjs \
  --mode poll \
  --telegram \
  --telegram-chat-id -1003881448843 \
  --telegram-thread-id 2716
```

## macOS Keep-Alive

For local macOS use, create a LaunchAgent plist that runs the command above. The repository ignores runtime logs and state files.

## Source Discovery

Scan historical ids and collect all source hosts:

```bash
node discover_biteagle_sources.mjs --limit 3000 --concurrency 8
```

Outputs are written under `data/source-discovery/`.

## Notes

The BitEagle frontend currently exposes detail-style endpoints rather than a public list endpoint:

- `/api/news?id=latest`
- `/api/news?id=<numeric-id>`
- `/api/news/comment?news_id=<numeric-id>`

The poller therefore uses `latest` as the stream cursor and fetches missing ids to avoid gaps.
