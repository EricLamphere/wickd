class ProposalError(Exception):
    """A quick action can't produce a proposal (with a user-facing reason)."""


class NothingToPropose(ProposalError):
    """There was nothing to change — an outcome, not a failure."""
