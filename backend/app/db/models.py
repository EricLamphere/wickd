from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    path: Mapped[str] = mapped_column(String(1024), unique=True)
    platform: Mapped[str] = mapped_column(String(64), default="unknown")
    profile: Mapped[str | None] = mapped_column(String(255), nullable=True)
    vscode_cmd: Mapped[str | None] = mapped_column(String(255), nullable=True)
    init_script_path: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    ignored: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    pin_order: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_init_status: Mapped[str] = mapped_column(String(32), default="idle")
    last_init_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_init_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_init_failed_step: Mapped[str | None] = mapped_column(String(255), nullable=True)

    init_steps: Mapped[list["InitStep"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="InitStep.order"
    )


class InitStep(Base):
    __tablename__ = "init_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    order: Mapped[int] = mapped_column(Integer, default=0)
    script_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    is_base: Mapped[bool] = mapped_column(default=False)
    enabled: Mapped[bool] = mapped_column(default=True)
    captured_vars: Mapped[str] = mapped_column(Text, default="")
    last_status: Mapped[str] = mapped_column(String(32), default="idle")
    last_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_log: Mapped[str] = mapped_column(Text, default="")

    project: Mapped[Project] = relationship(back_populates="init_steps")

    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_init_step_name"),)


class ModelStatus(Base):
    __tablename__ = "model_statuses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    unique_id: Mapped[str] = mapped_column(String(512), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # "model" or "test"
    parent_model_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="idle")
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_time: Mapped[float | None] = mapped_column(nullable=True)
    invocation_id: Mapped[int | None] = mapped_column(
        ForeignKey("run_invocations.id", ondelete="SET NULL"), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("project_id", "unique_id", name="uq_status_project_unique"),
    )



class ProjectEnvVar(Base):
    __tablename__ = "project_env_vars"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(255))
    value: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (UniqueConstraint("project_id", "key", name="uq_env_var_key"),)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class GlobalEnvVar(Base):
    """Default env vars applied to every dbt/init run and to global setup's pip install.
    The active profile's vars override these; project env vars override both."""
    __tablename__ = "global_env_vars"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(255), unique=True)
    value: Mapped[str] = mapped_column(Text, default="")


class GlobalProfile(Base):
    __tablename__ = "global_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    vars: Mapped[list["GlobalProfileVar"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class GlobalProfileVar(Base):
    __tablename__ = "global_profile_vars"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("global_profiles.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(255))
    value: Mapped[str] = mapped_column(Text, default="")

    profile: Mapped["GlobalProfile"] = relationship(back_populates="vars")

    __table_args__ = (UniqueConstraint("profile_id", "key", name="uq_global_profile_var"),)


class DriftSnapshot(Base):
    __tablename__ = "drift_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="running")  # running | done | error
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    total_models: Mapped[int] = mapped_column(Integer, default=0)
    checked_models: Mapped[int] = mapped_column(Integer, default=0)
    results_json: Mapped[str] = mapped_column(Text, default="[]")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # {materialization: count} of models the scan skipped (views, ephemeral, …)
    skipped_json: Mapped[str] = mapped_column(Text, default="{}")


class FreshnessSnapshot(Base):
    __tablename__ = "freshness_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="running")  # running | done | error
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    results_json: Mapped[str] = mapped_column(Text, default="[]")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class ColumnLineageSnapshot(Base):
    __tablename__ = "column_lineage_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="running")  # running | done | error
    total_models: Mapped[int] = mapped_column(Integer, default=0)
    checked_models: Mapped[int] = mapped_column(Integer, default=0)
    results_json: Mapped[str] = mapped_column(Text, default="{}")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    manifest_mtime: Mapped[float] = mapped_column(Float, default=0.0)
    # {downstream uid: [{node, column}]} — upstream columns each model filters/joins/groups on
    row_dependencies_json: Mapped[str] = mapped_column(Text, default="{}")
    # 1 = projection lineage only; 2 = also row dependencies (see api/column_lineage.py)
    lineage_version: Mapped[int] = mapped_column(Integer, default=1)


class RunInvocation(Base):
    __tablename__ = "run_invocations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    command: Mapped[str] = mapped_column(String(64))  # run, build, test, deps, init, etc.
    selector: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    cli_command: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="pending")
    log_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # JSON list of user-entered args for custom dbt commands (null for built-in runs); replayed on rerun
    custom_args: Mapped[str | None] = mapped_column(Text, nullable=True)
    # From run_results.json: --threads (or distinct thread ids) and dbt's own elapsed_time
    threads: Mapped[int | None] = mapped_column(Integer, nullable=True)
    elapsed_time: Mapped[float | None] = mapped_column(nullable=True)

    node_results: Mapped[list["InvocationModelResult"]] = relationship(
        back_populates="invocation", cascade="all, delete-orphan"
    )


class InvocationModelResult(Base):
    __tablename__ = "invocation_model_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    invocation_id: Mapped[int] = mapped_column(
        ForeignKey("run_invocations.id", ondelete="CASCADE"), index=True
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    unique_id: Mapped[str] = mapped_column(String(512))
    name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(32))  # "model" or "test"
    status: Mapped[str] = mapped_column(String(32))
    execution_time: Mapped[float | None] = mapped_column(nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Execute window + thread from run_results.json timing (NULL for runs recorded before timing capture)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    thread_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    rows_affected: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bytes_processed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    adapter_response_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    invocation: Mapped["RunInvocation"] = relationship(back_populates="node_results")


class LicenseState(Base):
    """Single-row (id=1) cache of the last-known Pro license/entitlement state.

    Validated against Polar's license-key API on a schedule (see
    app/licensing/), not on every request — this row is the grace-period
    cache that lets Pro features keep working for a while if Polar is
    unreachable (offline, outage), while still requiring a fresh successful
    check periodically so a canceled subscription doesn't stay entitled
    forever just by staying offline.
    """
    __tablename__ = "license_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    license_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    activation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_id: Mapped[str] = mapped_column(String(64))
    entitled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    status: Mapped[str] = mapped_column(String(32), default="unset")
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    customer_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    license_key_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    limit_activations: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AiConversation(Base):
    """An Ask-mode chat thread about a project (wickd Pro AI)."""
    __tablename__ = "ai_conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    messages: Mapped[list["AiMessage"]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="AiMessage.id"
    )


class AiMessage(Base):
    __tablename__ = "ai_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # user | assistant | action | query
    content: Mapped[str] = mapped_column(Text, default="")
    # node selected when the question was asked (its context was sent to the model)
    unique_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # role "action": a quick action (e.g. Document) run from this chat; shown inline with its result
    proposal_id: Mapped[int | None] = mapped_column(
        ForeignKey("ai_proposals.id", ondelete="SET NULL"), nullable=True
    )
    proposal: Mapped["AiProposal | None"] = relationship()
    # role "query": the AI-written SQL and, once run, its results (see api/ai_query.py)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    conversation: Mapped["AiConversation"] = relationship(back_populates="messages")


class AiProposal(Base):
    """File changes the AI generated, waiting for the user to accept or reject each file."""
    __tablename__ = "ai_proposals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(32))  # document
    unique_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    # generating | ready | applied | rejected | dismissed | error | empty (nothing needed changing)
    status: Mapped[str] = mapped_column(String(16), default="generating")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # what the AI produced, kept for the chat history: {"description", "columns": {name: text}}
    result_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    files: Mapped[list["AiProposalFile"]] = relationship(
        back_populates="proposal", cascade="all, delete-orphan", order_by="AiProposalFile.id"
    )


class AiProposalFile(Base):
    __tablename__ = "ai_proposal_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    proposal_id: Mapped[int] = mapped_column(ForeignKey("ai_proposals.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1024))  # relative to the project root (posix)
    original_text: Mapped[str | None] = mapped_column(Text, nullable=True)  # None → new file
    proposed_text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | accepted | rejected

    proposal: Mapped["AiProposal"] = relationship(back_populates="files")
