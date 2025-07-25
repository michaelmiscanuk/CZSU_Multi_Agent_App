# CHANGE here which type of agent is used. Specify agent type here.
agent_type = "basic1"  # Options: "basic1_multiple_queries", "basic2",

# Import based on selected agent type
if agent_type == "basic1":
    from .agent import create_graph
else:
    raise ValueError(
        f"Unknown agent type: {agent_type}. Valid options are: 'basic_reflection', 'initial'"
    )

# __all__ controls what gets exported when using wildcard imports (from my_agent import *)
# By only including 'create_graph', we maintain a clean public API that hides internal
# configuration like 'agent_type' and the conditional import logic. This allows client code
# to work consistently regardless of which agent implementation you've selected above.
__all__ = ["create_graph"]
