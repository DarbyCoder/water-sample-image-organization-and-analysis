"""
Apply the Supabase SQL migrations in ProjectCode/supabase/migrations/.

Every migration is written to be idempotent, so this script simply runs all of
them in filename order, each inside its own transaction -- a file that fails
part-way is rolled back completely and nothing after it runs.

Connects with SUPABASE_DB_URL from ProjectCode/.env. Use Supabase's *Session
pooler* connection string: the direct connection is IPv6-only and often fails
on campus Wi-Fi.

Usage (from ProjectCode/):
    pip install -r deploy/requirements-deploy.txt
    python deploy/apply_migrations.py           # apply every migration, then verify
    python deploy/apply_migrations.py --check   # only test the connection
"""

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = PROJECT_DIR / "supabase" / "migrations"

TABLES = ["folders", "images", "qa_log", "profiles", "measurement_columns", "role_requests",
          "label_options", "pending_labels"]
VIEWS = ["folders_visible", "dashboard_stats", "chart_site_counts",
         "chart_date_counts", "chart_water_body_counts",
         "folder_labeling_progress", "labeling_stats", "label_counts"]
ROLE_FUNCTIONS = ["is_admin()", "admin_list_users()", "set_user_role(uuid, text)",
                   "can_label()", "my_labeling_count()", "admin_labeling_by_user()",
                   "is_owner()", "request_role(text)", "cancel_role_request()",
                   "review_role_request(uuid, boolean)", "team_labeling_progress()",
                   "admin_update_label(text, text, text)", "admin_delete_label(text)",
                   "submit_labels(text[], text)", "folder_pending(text)", "review_queue(integer)",
                   "review_counts()", "submit_review(text, text)", "disputed_list()",
                   "resolve_dispute(text, text)", "make_label_official(text, text, uuid)"]


def get_db_url() -> str:
    load_dotenv(PROJECT_DIR / ".env")
    url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not url:
        sys.exit("ERROR: SUPABASE_DB_URL is not set. Copy ProjectCode/.env.example "
                 "to ProjectCode/.env and fill it in.")
    return url


def describe(url: str) -> str:
    """user@host:port/db -- never the password."""
    parts = urlsplit(url)
    return f"{parts.username}@{parts.hostname}:{parts.port}{parts.path}"


def connect(url: str) -> psycopg.Connection:
    """Autocommit connection: work that must be atomic goes in conn.transaction()."""
    try:
        return psycopg.connect(url, connect_timeout=20, autocommit=True)
    except psycopg.OperationalError as exc:
        sys.exit(f"ERROR: could not connect to {describe(url)}\n{exc}\n"
                 "Check that SUPABASE_DB_URL is the Session pooler string, that the "
                 "password is URL-encoded, and that the project isn't paused.")


def verify(conn: psycopg.Connection) -> bool:
    """Spot-check that the objects exist and the API roles are locked down."""
    ok = True

    def check(label: str, passed: bool) -> None:
        nonlocal ok
        ok = ok and passed
        print(f"  [{'ok' if passed else 'FAIL'}] {label}")

    for t in TABLES:
        row = conn.execute(
            "select relrowsecurity from pg_class where oid = to_regclass(%s)",
            (f"public.{t}",)).fetchone()
        check(f"table {t} exists with RLS enabled", bool(row and row[0]))

    for v in VIEWS:
        row = conn.execute(
            "select 'security_invoker=true' = any(reloptions) from pg_class "
            "where oid = to_regclass(%s)", (f"public.{v}",)).fetchone()
        check(f"view {v} exists with security_invoker", bool(row and row[0]))

    for trigger in ["on_auth_user_created", "on_auth_user_updated"]:
        row = conn.execute(
            "select 1 from pg_trigger where tgname = %s "
            "and tgrelid = 'auth.users'::regclass", (trigger,)).fetchone()
        check(f"trigger {trigger} on auth.users", row is not None)

    def priv(sql: str, *args) -> bool:
        return conn.execute(sql, args).fetchone()[0]

    check("anon can read folders",
          priv("select has_table_privilege('anon', 'public.folders', 'select')"))
    check("anon cannot write images",
          not priv("select has_table_privilege('anon', 'public.images', 'insert, update, delete, truncate')"))
    check("anon cannot read profiles",
          not priv("select has_table_privilege('anon', 'public.profiles', 'select')"))
    check("authenticated cannot update profiles",
          not priv("select has_table_privilege('authenticated', 'public.profiles', 'update')"))
    check("authenticated can update images.label",
          priv("select has_column_privilege('authenticated', 'public.images', 'label', 'update')"))
    check("authenticated cannot update images.labeled_by",
          not priv("select has_column_privilege('authenticated', 'public.images', 'labeled_by', 'update')"))
    check("authenticated cannot update images.width",
          not priv("select has_column_privilege('authenticated', 'public.images', 'width', 'update')"))
    check("authenticated cannot update images.diameter_esd",
          not priv("select has_column_privilege('authenticated', 'public.images', 'diameter_esd', 'update')"))
    check("anon can read measurement_columns",
          priv("select has_table_privilege('anon', 'public.measurement_columns', 'select')"))
    check("anon cannot write measurement_columns",
          not priv("select has_table_privilege('anon', 'public.measurement_columns', 'insert, update, delete, truncate')"))
    check("anon can execute measurement_folder_counts(jsonb)",
          priv("select has_function_privilege('anon', 'public.measurement_folder_counts(jsonb)', 'execute')"))
    filterable = conn.execute("select count(*) from public.measurement_columns").fetchone()[0]
    check(f"measurement_columns lists 64 filters (found {filterable})", filterable == 64)
    check("anon cannot read role_requests",
          not priv("select has_table_privilege('anon', 'public.role_requests', 'select')"))
    check("authenticated cannot write role_requests",
          not priv("select has_table_privilege('authenticated', 'public.role_requests', 'insert, update, delete, truncate')"))
    check("anon can read label_options",
          priv("select has_table_privilege('anon', 'public.label_options', 'select')"))
    check("anon cannot write label_options",
          not priv("select has_table_privilege('anon', 'public.label_options', 'insert, update, delete, truncate')"))
    check("authenticated can add a label (name, category)",
          priv("select has_column_privilege('authenticated', 'public.label_options', 'name', 'insert')")
          and priv("select has_column_privilege('authenticated', 'public.label_options', 'category', 'insert')"))
    check("authenticated cannot set label_options.is_builtin",
          not priv("select has_column_privilege('authenticated', 'public.label_options', 'is_builtin', 'insert')"))
    check("authenticated cannot update or delete label_options",
          not priv("select has_table_privilege('authenticated', 'public.label_options', 'update, delete, truncate')"))
    check("trigger images_check_label on images",
          conn.execute("select 1 from pg_trigger where tgname = 'images_check_label' "
                       "and tgrelid = 'public.images'::regclass").fetchone() is not None)
    builtin = conn.execute("select count(*) from public.label_options where is_builtin").fetchone()[0]
    check(f"label_options has the 12 starting labels (found {builtin})", builtin == 12)
    check("nobody reads pending_labels directly (blind review)",
          not priv("select has_table_privilege('anon', 'public.pending_labels', 'select')")
          and not priv("select has_table_privilege('authenticated', 'public.pending_labels', 'select')"))
    check("authenticated cannot execute make_label_official",
          not priv("select has_function_privilege('authenticated', 'public.make_label_official(text, text, uuid)', 'execute')"))
    check("only admins update images.label directly (006)",
          conn.execute("select 1 from pg_policies where schemaname = 'public' and tablename = 'images' "
                       "and policyname = 'Labelers can set the label'").fetchone() is None)
    for fn in ROLE_FUNCTIONS:
        check(f"anon cannot execute {fn}",
              not priv("select has_function_privilege('anon', %s, 'execute')", f"public.{fn}"))

    # 0 until the project account's first confirmed sign-in; never more than 1.
    owners = conn.execute("select count(*) from public.profiles where role = 'owner'").fetchone()[0]
    admins = conn.execute("select count(*) from public.profiles where role = 'admin'").fetchone()[0]
    users = conn.execute("select count(*) from public.profiles").fetchone()[0]
    print(f"  profiles: {users} account(s), {owners} owner, {admins} other admin(s)")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Apply Supabase migrations.")
    parser.add_argument("--check", action="store_true",
                        help="only test the database connection")
    args = parser.parse_args()

    url = get_db_url()
    print(f"Connecting to {describe(url)} ...")
    with connect(url) as conn:
        version = conn.execute("show server_version").fetchone()[0]
        print(f"Connected (Postgres {version}).")
        if args.check:
            return

        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        if not files:
            sys.exit(f"ERROR: no .sql files in {MIGRATIONS_DIR}")

        for path in files:
            print(f"Applying {path.name} ...")
            try:
                with conn.transaction():
                    conn.execute(path.read_text(encoding="utf-8"))
            except psycopg.Error as exc:
                sys.exit(f"ERROR in {path.name} (rolled back, nothing from this file was applied):\n{exc}")
            print(f"  {path.name} applied.")

        print("Verifying ...")
        if not verify(conn):
            sys.exit("Verification FAILED -- see the lines marked FAIL above.")
        print("All migrations applied and verified.")


if __name__ == "__main__":
    main()
