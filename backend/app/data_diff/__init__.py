"""Data diff (wickd Pro, plan 06): models built in dev compared with their prod relations.

keys.py (which key rows are matched on), prepare.py (relations, schemas, joined vs separate per
model), driver.py (many models' statements in one `dbt show` per round), job.py (the background
job, snapshots, events). Routes in api/data_diff.py; SQL and interpretation in wickd_pro.data_diff
(shim: app/dbt/data_diff.py).
"""
