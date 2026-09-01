"""One router per Console page, mounted by `garuda.api.app`.

A page gets its endpoints when the page is made to work, rather than an API
tier being built ahead of every page at once. Each router is a factory taking
the session factory, because the routes need a database session and FastAPI's
own dependency machinery would otherwise need module-level state.
"""
