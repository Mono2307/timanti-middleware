"""
fetch_shopify_metafields.py
===========================
Fetches ALL Shopify orders and draft orders, including every attached metafield,
using the GraphQL Bulk Operations API, and writes the reconstructed result to
raw_shopify_metafields.json.

Bulk operations run one query at a time per shop and stream results as JSONL,
where connection children (metafields) are emitted as separate lines linked to
their parent via __parentId. This script runs two bulk ops sequentially
(orders, then draft orders), downloads each JSONL, and reassembles the nested
structure.

Credentials are read from the .env file sitting next to this script.
"""

import json
import time
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE / ".env"
OUTPUT_FILE = HERE / "raw_shopify_metafields.json"
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 60 * 30  # 30 minutes


# ── env loading ───────────────────────────────────────────────────────────────

def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        sys.exit(f"ERROR: env file not found at {path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


ENV = load_env(ENV_FILE)
STORE_DOMAIN = ENV.get("SHOPIFY_STORE_DOMAIN", "auracarat.myshopify.com")
API_VERSION = ENV.get("SHOPIFY_API_VERSION", "2024-10")
TOKEN = ENV.get("SHOPIFY_ACCESS_TOKEN", "")
if not TOKEN:
    sys.exit("ERROR: SHOPIFY_ACCESS_TOKEN missing from .env")

GRAPHQL_URL = f"https://{STORE_DOMAIN}/admin/api/{API_VERSION}/graphql.json"
HEADERS = {"X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json"}


# ── bulk query bodies ─────────────────────────────────────────────────────────
# A bulk query has a single top-level connection. Metafields are a nested
# connection and stream as child JSONL lines tagged with __parentId.

ORDERS_QUERY = """
{
  orders {
    edges {
      node {
        id
        name
        createdAt
        metafields {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  }
}
"""

DRAFT_ORDERS_QUERY = """
{
  draftOrders {
    edges {
      node {
        id
        name
        createdAt
        metafields {
          edges {
            node {
              id
              namespace
              key
              value
              type
            }
          }
        }
      }
    }
  }
}
"""

BULK_RUN_MUTATION = """
mutation bulkRun($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
"""

CURRENT_BULK_OP = """
{
  currentBulkOperation {
    id
    status
    errorCode
    objectCount
    url
  }
}
"""


def gql(query: str, variables: dict | None = None) -> dict:
    r = requests.post(GRAPHQL_URL, headers=HEADERS,
                      json={"query": query, "variables": variables or {}},
                      timeout=60)
    r.raise_for_status()
    j = r.json()
    if j.get("errors"):
        raise RuntimeError(f"GraphQL errors: {json.dumps(j['errors'], indent=2)}")
    return j["data"]


def run_bulk(query: str, label: str) -> str | None:
    """Starts a bulk op, polls to completion, returns the JSONL download URL."""
    print(f"\n[{label}] starting bulk operation...")
    data = gql(BULK_RUN_MUTATION, {"query": query})
    errs = data["bulkOperationRunQuery"]["userErrors"]
    if errs:
        raise RuntimeError(f"[{label}] userErrors: {errs}")
    op = data["bulkOperationRunQuery"]["bulkOperation"]
    print(f"[{label}] op {op['id']} status={op['status']}")

    waited = 0
    while True:
        time.sleep(POLL_INTERVAL_S)
        waited += POLL_INTERVAL_S
        cur = gql(CURRENT_BULK_OP)["currentBulkOperation"]
        status = cur["status"]
        print(f"[{label}] status={status} objects={cur.get('objectCount')}")
        if status == "COMPLETED":
            if not cur.get("url"):
                print(f"[{label}] COMPLETED but no URL (0 records)")
                return None
            return cur["url"]
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise RuntimeError(f"[{label}] bulk op {status}: {cur.get('errorCode')}")
        if waited > POLL_TIMEOUT_S:
            raise TimeoutError(f"[{label}] timed out after {waited}s (status={status})")


def download_jsonl(url: str, label: str) -> list[dict]:
    print(f"[{label}] downloading JSONL...")
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    rows = [json.loads(line) for line in r.text.splitlines() if line.strip()]
    print(f"[{label}] {len(rows)} JSONL lines")
    return rows


def reconstruct(rows: list[dict]) -> list[dict]:
    """Reassembles nested objects from flat JSONL using __parentId.

    Parent objects (orders/draft orders) have no __parentId. Metafield child
    lines reference their parent's id. We attach each child to its parent's
    'metafields' list.
    """
    parents: dict[str, dict] = {}
    order_keys: list[str] = []
    for row in rows:
        pid = row.get("__parentId")
        if pid is None:
            node = {k: v for k, v in row.items() if k != "__parentId"}
            node["metafields"] = []
            parents[row["id"]] = node
            order_keys.append(row["id"])
        else:
            child = {k: v for k, v in row.items() if k != "__parentId"}
            parent = parents.get(pid)
            if parent is not None:
                parent["metafields"].append(child)
    return [parents[k] for k in order_keys]


def main():
    result = {
        "store": STORE_DOMAIN,
        "api_version": API_VERSION,
        "orders": [],
        "draft_orders": [],
    }

    orders_url = run_bulk(ORDERS_QUERY, "orders")
    if orders_url:
        result["orders"] = reconstruct(download_jsonl(orders_url, "orders"))

    drafts_url = run_bulk(DRAFT_ORDERS_QUERY, "draft_orders")
    if drafts_url:
        result["draft_orders"] = reconstruct(download_jsonl(drafts_url, "draft_orders"))

    OUTPUT_FILE.write_text(json.dumps(result, indent=2, ensure_ascii=False),
                           encoding="utf-8")
    print(f"\nDONE: {len(result['orders'])} orders, "
          f"{len(result['draft_orders'])} draft orders "
          f"-> {OUTPUT_FILE.name}")


if __name__ == "__main__":
    main()
