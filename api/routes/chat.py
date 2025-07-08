# Load environment variables early
import os

# CRITICAL: Set Windows event loop policy FIRST, before any other imports
# This must be the very first thing that happens to fix psycopg compatibility
import sys
import time

# Standard imports
import traceback
from typing import Dict, List

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

if sys.platform == "win32":
    import asyncio

    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Constants
try:
    from pathlib import Path

    BASE_DIR = Path(__file__).resolve().parents[2]
except NameError:
    BASE_DIR = Path(os.getcwd()).parents[0]


# Import authentication dependencies
from api.dependencies.auth import get_current_user

# Import models
from api.models.requests import FeedbackRequest, SentimentRequest
from api.models.responses import (
    ChatMessage,
    ChatThreadResponse,
    PaginatedChatThreadsResponse,
)

# Import debug functions
from api.utils.debug import (
    print__chat_all_messages_one_thread_debug,
    print__chat_sentiments_debug,
    print__chat_threads_debug,
    print__delete_chat_debug,
    print__sentiment_flow,
)

# Import utility functions
from api.utils.memory import log_memory_usage, perform_deletion_operations

# Import database connection functions
sys.path.insert(0, str(BASE_DIR))
# Import global variables from api.config.settings
from api.config.settings import (
    BULK_CACHE_TIMEOUT,
    MAX_CONCURRENT_ANALYSES,
    _bulk_loading_cache,
    _bulk_loading_locks,
)
from api.utils.debug import print__chat_all_messages_debug
from my_agent.utils.postgres_checkpointer import (
    get_conversation_messages_from_checkpoints,
    get_direct_connection,
    get_healthy_checkpointer,
    get_queries_and_results_from_latest_checkpoint,
    get_thread_run_sentiments,
    get_user_chat_threads,
    get_user_chat_threads_count,
)

# Load environment variables
load_dotenv()

# Create router for chat endpoints
router = APIRouter()


async def get_thread_messages_with_metadata(
    checkpointer, thread_id: str, user_email: str, source_context: str = "general"
) -> List[ChatMessage]:
    """
    Extract and process all messages for a single thread with metadata.

    Args:
        checkpointer: The database checkpointer instance
        thread_id: The thread ID to process
        user_email: The user's email
        source_context: Context for metadata (e.g., "single_thread", "bulk_processing")

    Returns:
        List of ChatMessage objects for the thread
    """

    print__chat_all_messages_debug(
        f"🔄 Processing thread {thread_id} for user {user_email}"
    )

    try:
        # Get conversation messages from checkpoints
        print__chat_all_messages_debug(
            f"🔍 Getting conversation messages from checkpoints for thread: {thread_id}"
        )
        stored_messages = await get_conversation_messages_from_checkpoints(
            checkpointer, thread_id, user_email
        )

        if not stored_messages:
            print__chat_all_messages_debug(
                f"⚠ No messages found in checkpoints for thread {thread_id}"
            )
            return []

        print__chat_all_messages_debug(
            f"📄 Found {len(stored_messages)} messages for thread {thread_id}"
        )

        # Get additional metadata from latest checkpoint
        print__chat_all_messages_debug(
            f"🔍 Getting queries and results from latest checkpoint for thread: {thread_id}"
        )
        queries_and_results = await get_queries_and_results_from_latest_checkpoint(
            checkpointer, thread_id
        )
        print__chat_all_messages_debug(
            f"🔍 Retrieved {len(queries_and_results) if queries_and_results else 0} queries and results"
        )

        # Get dataset information and SQL query from latest checkpoint
        datasets_used = []
        sql_query = None
        top_chunks = []

        try:
            print__chat_all_messages_debug(
                f"🔍 Getting state snapshot for thread: {thread_id}"
            )
            config = {"configurable": {"thread_id": thread_id}}
            state_snapshot = await checkpointer.aget_tuple(config)

            if state_snapshot and state_snapshot.checkpoint:
                print__chat_all_messages_debug(
                    f"🔍 State snapshot found for thread: {thread_id}"
                )
                channel_values = state_snapshot.checkpoint.get("channel_values", {})
                top_selection_codes = channel_values.get("top_selection_codes", [])
                datasets_used = top_selection_codes
                print__chat_all_messages_debug(
                    f"🔍 Found {len(datasets_used)} datasets used"
                )

                # Get PDF chunks
                checkpoint_top_chunks = channel_values.get("top_chunks", [])
                print__chat_all_messages_debug(
                    f"🔍 Found {len(checkpoint_top_chunks)} PDF chunks in checkpoint"
                )
                if checkpoint_top_chunks:
                    for j, chunk in enumerate(checkpoint_top_chunks):
                        print__chat_all_messages_debug(
                            f"🔍 Processing PDF chunk {j+1}/{len(checkpoint_top_chunks)}"
                        )
                        chunk_data = {
                            "content": (
                                chunk.page_content
                                if hasattr(chunk, "page_content")
                                else str(chunk)
                            ),
                            "metadata": (
                                chunk.metadata if hasattr(chunk, "metadata") else {}
                            ),
                        }
                        top_chunks.append(chunk_data)
                    print__chat_all_messages_debug(
                        f"🔍 Processed {len(top_chunks)} PDF chunks"
                    )

                # Extract SQL query
                if queries_and_results:
                    sql_query = (
                        queries_and_results[-1][0] if queries_and_results[-1] else None
                    )
                    print__chat_all_messages_debug(
                        f"🔍 SQL query extracted: {'Yes' if sql_query else 'No'}"
                    )
            else:
                print__chat_all_messages_debug(
                    f"🔍 No state snapshot found for thread: {thread_id}"
                )

        except Exception as e:
            print__chat_all_messages_debug(
                f"⚠️ Could not get datasets/SQL/chunks from checkpoint for thread {thread_id}: {e}"
            )
            print__chat_all_messages_debug(
                f"🔍 Checkpoint metadata error type: {type(e).__name__}"
            )
            print__chat_all_messages_debug(
                f"🔍 Checkpoint metadata error traceback: {traceback.format_exc()}"
            )

        # Convert stored messages to frontend format
        chat_messages = []
        print__chat_all_messages_debug(
            f"🔍 Converting {len(stored_messages)} stored messages to frontend format"
        )

        for i, stored_msg in enumerate(stored_messages):
            print__chat_all_messages_debug(
                f"🔍 Processing stored message {i+1}/{len(stored_messages)}"
            )
            # Create meta information for AI messages
            meta_info = {}
            if not stored_msg["is_user"]:
                print__chat_all_messages_debug(
                    "🔍 Processing AI message - adding metadata"
                )
                if queries_and_results:
                    meta_info["queriesAndResults"] = queries_and_results
                    print__chat_all_messages_debug(
                        "🔍 Added queries and results to meta"
                    )
                if datasets_used:
                    meta_info["datasetsUsed"] = datasets_used
                    print__chat_all_messages_debug(
                        f"🔍 Added {len(datasets_used)} datasets to meta"
                    )
                if sql_query:
                    meta_info["sqlQuery"] = sql_query
                    print__chat_all_messages_debug("🔍 Added SQL query to meta")
                if top_chunks:
                    meta_info["topChunks"] = top_chunks
                    print__chat_all_messages_debug(
                        f"🔍 Added {len(top_chunks)} chunks to meta"
                    )
                meta_info["source"] = source_context
            else:
                print__chat_all_messages_debug(
                    "🔍 Processing user message - no metadata needed"
                )

            queries_results_for_frontend = None
            if not stored_msg["is_user"] and queries_and_results:
                queries_results_for_frontend = queries_and_results
                print__chat_all_messages_debug(
                    "🔍 Set queries_results_for_frontend for AI message"
                )

            is_user_flag = stored_msg["is_user"]
            print__chat_all_messages_debug(
                f"🔍 Creating ChatMessage: isUser={is_user_flag}"
            )

            chat_message = ChatMessage(
                id=stored_msg["id"],
                threadId=thread_id,
                user=user_email if is_user_flag else "AI",
                content=stored_msg["content"],
                isUser=is_user_flag,
                createdAt=int(stored_msg["timestamp"].timestamp() * 1000),
                error=None,
                meta=meta_info if meta_info else None,
                queriesAndResults=queries_results_for_frontend,
                isLoading=False,
                startedAt=None,
                isError=False,
            )

            chat_messages.append(chat_message)
            print__chat_all_messages_debug("🔍 ChatMessage created and added to list")

        print__chat_all_messages_debug(
            f"✅ Processed {len(chat_messages)} messages for thread {thread_id}"
        )
        return chat_messages

    except Exception as e:
        print__chat_all_messages_debug(f"❌ Error processing thread {thread_id}: {e}")
        print__chat_all_messages_debug(
            f"🔍 Thread processing error type: {type(e).__name__}"
        )
        print__chat_all_messages_debug(
            f"🔍 Thread processing error traceback: {traceback.format_exc()}"
        )
        return []


@router.get("/chat/{thread_id}/sentiments")
async def get_thread_sentiments(thread_id: str, user=Depends(get_current_user)):
    """Get sentiment values for all messages in a thread."""

    print__chat_sentiments_debug("🔍 CHAT_SENTIMENTS ENDPOINT - ENTRY POINT")
    print__chat_sentiments_debug(f"🔍 Request received: thread_id={thread_id}")

    user_email = user.get("email")
    print__chat_sentiments_debug(f"🔍 User email extracted: {user_email}")

    if not user_email:
        print__chat_sentiments_debug("🚨 No user email found in token")
        raise HTTPException(status_code=401, detail="User email not found in token")

    try:
        print__chat_sentiments_debug(
            f"🔍 Getting sentiments for thread {thread_id}, user: {user_email}"
        )
        print__sentiment_flow(
            f"📥 Getting sentiments for thread {thread_id}, user: {user_email}"
        )
        sentiments = await get_thread_run_sentiments(user_email, thread_id)
        print__chat_sentiments_debug(f"🔍 Retrieved {len(sentiments)} sentiment values")

        print__sentiment_flow(f"✅ Retrieved {len(sentiments)} sentiment values")
        print__chat_sentiments_debug("🔍 CHAT_SENTIMENTS ENDPOINT - SUCCESSFUL EXIT")
        return sentiments

    except Exception as e:
        print__chat_sentiments_debug(
            f"🚨 Exception in chat sentiments processing: {type(e).__name__}: {str(e)}"
        )
        print__chat_sentiments_debug(
            f"🚨 Chat sentiments processing traceback: {traceback.format_exc()}"
        )
        print__sentiment_flow(
            f"❌ Failed to get sentiments for thread {thread_id}: {e}"
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to get sentiments: {e}"
        ) from e


@router.get("/chat-threads")
async def get_chat_threads(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    limit: int = Query(10, ge=1, le=50, description="Number of threads per page"),
    user=Depends(get_current_user),
) -> PaginatedChatThreadsResponse:
    """Get paginated chat threads for the authenticated user."""

    print__chat_threads_debug("🔍 CHAT_THREADS ENDPOINT - ENTRY POINT")
    print__chat_threads_debug(f"🔍 Request parameters: page={page}, limit={limit}")

    try:
        user_email = user["email"]
        print__chat_threads_debug(f"🔍 User email extracted: {user_email}")
        print__chat_threads_debug(
            f"Loading chat threads for user: {user_email} (page: {page}, limit: {limit})"
        )

        print__chat_threads_debug("🔍 Starting simplified approach")
        print__chat_threads_debug("Getting chat threads with simplified approach")

        # Get total count first
        print__chat_threads_debug("🔍 Getting total threads count")
        print__chat_threads_debug(f"Getting chat threads count for user: {user_email}")
        total_count = await get_user_chat_threads_count(user_email)
        print__chat_threads_debug(f"🔍 Total count retrieved: {total_count}")
        print__chat_threads_debug(
            f"Total threads count for user {user_email}: {total_count}"
        )

        # Calculate offset for pagination
        offset = (page - 1) * limit
        print__chat_threads_debug(f"🔍 Calculated offset: {offset}")

        # Get threads for this page
        print__chat_threads_debug(
            f"🔍 Getting chat threads for user: {user_email} (limit: {limit}, offset: {offset})"
        )
        print__chat_threads_debug(
            f"Getting chat threads for user: {user_email} (limit: {limit}, offset: {offset})"
        )
        threads = await get_user_chat_threads(user_email, limit=limit, offset=offset)
        print__chat_threads_debug(f"🔍 Retrieved threads: {threads}")
        if threads is None:
            print__chat_threads_debug(
                "get_user_chat_threads returned None! Setting to empty list."
            )
            threads = []
        print__chat_threads_debug(f"🔍 Retrieved {len(threads)} threads from database")
        print__chat_threads_debug(
            f"Retrieved {len(threads)} threads for user {user_email}"
        )

        # Try/except around the for-loop to catch and print any errors
        try:
            chat_thread_responses = []
            for thread in threads:
                print("[GENERIC-DEBUG] Processing thread dict:", thread)
                chat_thread_response = ChatThreadResponse(
                    thread_id=thread["thread_id"],
                    latest_timestamp=thread["latest_timestamp"],
                    run_count=thread["run_count"],
                    title=thread["title"],
                    full_prompt=thread["full_prompt"],
                )
                chat_thread_responses.append(chat_thread_response)
        except Exception as e:
            print("[GENERIC-ERROR] Exception in /chat-threads for-loop:", e)
            print(traceback.format_exc())
            # Return empty result on error
            return PaginatedChatThreadsResponse(
                threads=[], total_count=0, page=page, limit=limit, has_more=False
            )

        # Convert to response format
        print__chat_threads_debug("🔍 Converting threads to response format")
        chat_thread_responses = []
        for thread in threads:
            chat_thread_response = ChatThreadResponse(
                thread_id=thread["thread_id"],
                latest_timestamp=thread["latest_timestamp"],
                run_count=thread["run_count"],
                title=thread["title"],
                full_prompt=thread["full_prompt"],
            )
            chat_thread_responses.append(chat_thread_response)

        # Calculate pagination info
        has_more = (offset + len(chat_thread_responses)) < total_count
        print__chat_threads_debug(f"🔍 Pagination calculated: has_more={has_more}")

        print__chat_threads_debug(
            f"Retrieved {len(threads)} threads for user {user_email} (total: {total_count})"
        )
        print__chat_threads_debug(
            f"Returning {len(chat_thread_responses)} threads to frontend (page {page}/{(total_count + limit - 1) // limit})"
        )

        result = PaginatedChatThreadsResponse(
            threads=chat_thread_responses,
            total_count=total_count,
            page=page,
            limit=limit,
            has_more=has_more,
        )
        print__chat_threads_debug("🔍 CHAT_THREADS ENDPOINT - SUCCESSFUL EXIT")
        return result

    except Exception as e:
        print__chat_threads_debug(
            f"🚨 Exception in chat threads processing: {type(e).__name__}: {str(e)}"
        )
        print__chat_threads_debug(
            f"🚨 Chat threads processing traceback: {traceback.format_exc()}"
        )
        print__chat_threads_debug(f"❌ Error getting chat threads: {e}")
        print__chat_threads_debug(f"Full traceback: {traceback.format_exc()}")

        # Return error response
        result = PaginatedChatThreadsResponse(
            threads=[], total_count=0, page=page, limit=limit, has_more=False
        )
        print__chat_threads_debug("🔍 CHAT_THREADS ENDPOINT - ERROR EXIT")
        return result


@router.delete("/chat/{thread_id}")
async def delete_chat_checkpoints(thread_id: str, user=Depends(get_current_user)):
    """Delete all PostgreSQL checkpoint records and thread entries for a specific thread_id."""

    print__delete_chat_debug("🔍 DELETE_CHAT ENDPOINT - ENTRY POINT")
    print__delete_chat_debug(f"🔍 Request received: thread_id={thread_id}")

    user_email = user.get("email")
    print__delete_chat_debug(f"🔍 User email extracted: {user_email}")

    if not user_email:
        print__delete_chat_debug("🚨 No user email found in token")
        raise HTTPException(status_code=401, detail="User email not found in token")

    print__delete_chat_debug(
        f"🗑️ Deleting chat thread {thread_id} for user {user_email}"
    )

    try:
        # Get a healthy checkpointer
        print__delete_chat_debug("🔧 DEBUG: Getting healthy checkpointer...")
        checkpointer = await get_healthy_checkpointer()
        print__delete_chat_debug(
            f"🔧 DEBUG: Checkpointer type: {type(checkpointer).__name__}"
        )

        # Check if we have a PostgreSQL checkpointer (not InMemorySaver)
        print__delete_chat_debug(
            "🔧 DEBUG: Checking if checkpointer has 'conn' attribute..."
        )
        if not hasattr(checkpointer, "conn"):
            print__delete_chat_debug(
                "⚠️ No PostgreSQL checkpointer available - nothing to delete"
            )
            return {
                "message": "No PostgreSQL checkpointer available - nothing to delete"
            }

        print__delete_chat_debug("🔧 DEBUG: Checkpointer has 'conn' attribute")
        print__delete_chat_debug(
            f"🔧 DEBUG: checkpointer.conn type: {type(checkpointer.conn).__name__}"
        )

        # Access the connection through the conn attribute
        conn_obj = checkpointer.conn
        print__delete_chat_debug(
            f"🔧 DEBUG: Connection object set, type: {type(conn_obj).__name__}"
        )

        # FIXED: Handle both connection pool and single connection cases
        if hasattr(conn_obj, "connection") and callable(
            getattr(conn_obj, "connection", None)
        ):
            # It's a connection pool - use pool.connection()
            print__delete_chat_debug("🔧 DEBUG: Using connection pool pattern...")
            async with conn_obj.connection() as conn:
                print__delete_chat_debug(
                    f"🔧 DEBUG: Successfully got connection from pool, type: {type(conn).__name__}"
                )
                result_data = await perform_deletion_operations(
                    conn, user_email, thread_id
                )
                return result_data
        else:
            # It's a single connection - use it directly
            print__delete_chat_debug("🔧 DEBUG: Using single connection pattern...")
            conn = conn_obj
            print__delete_chat_debug(
                f"🔧 DEBUG: Using direct connection, type: {type(conn).__name__}"
            )
            result_data = await perform_deletion_operations(conn, user_email, thread_id)
            return result_data

    except Exception as e:
        error_msg = str(e)
        print__delete_chat_debug(
            f"❌ Failed to delete checkpoint records for thread {thread_id}: {e}"
        )
        print__delete_chat_debug(f"🔧 DEBUG: Main exception type: {type(e).__name__}")
        print__delete_chat_debug(
            f"🔧 DEBUG: Main exception traceback: {traceback.format_exc()}"
        )

        # If it's a connection error, don't treat it as a failure since it means
        # there are likely no records to delete anyway
        if any(
            keyword in error_msg.lower()
            for keyword in [
                "ssl error",
                "connection",
                "timeout",
                "operational error",
                "server closed",
                "bad connection",
                "consuming input failed",
            ]
        ):
            print__delete_chat_debug(
                "⚠️ PostgreSQL connection unavailable - no records to delete"
            )
            return {
                "message": "PostgreSQL connection unavailable - no records to delete",
                "thread_id": thread_id,
                "user_email": user_email,
                "warning": "Database connection issues",
            }
        else:
            raise HTTPException(
                status_code=500, detail=f"Failed to delete checkpoint records: {e}"
            ) from e


@router.get("/chat/all-messages-for-one-thread/{thread_id}")
async def get_all_chat_messages_for_one_thread(
    thread_id: str, user=Depends(get_current_user)
) -> Dict:
    """Get all chat messages for a specific thread using the same logic as bulk loading."""

    print__chat_all_messages_one_thread_debug(
        "🔍 CHAT_SINGLE_THREAD ENDPOINT - ENTRY POINT"
    )

    user_email = user["email"]
    print__chat_all_messages_one_thread_debug(f"🔍 User email extracted: {user_email}")
    print__chat_all_messages_one_thread_debug(
        f"📥 SINGLE THREAD REQUEST: Loading chat messages for thread: {thread_id}, user: {user_email}"
    )

    # Check if we have a recent cached result
    cache_key = f"single_thread_{thread_id}_{user_email}"
    current_time = time.time()
    print__chat_all_messages_one_thread_debug(f"🔍 Cache key: {cache_key}")
    print__chat_all_messages_one_thread_debug(f"🔍 Current time: {current_time}")

    if cache_key in _bulk_loading_cache:
        print__chat_all_messages_one_thread_debug("🔍 Cache entry found for thread")
        cached_data, cache_time = _bulk_loading_cache[cache_key]
        cache_age = current_time - cache_time
        print__chat_all_messages_one_thread_debug(
            f"🔍 Cache age: {cache_age:.1f}s (timeout: {BULK_CACHE_TIMEOUT}s)"
        )

        if cache_age < BULK_CACHE_TIMEOUT:
            print__chat_all_messages_one_thread_debug(
                f"✅ CACHE HIT: Returning cached thread data for {thread_id} (age: {cache_age:.1f}s)"
            )

            # Return cached data with appropriate headers
            response = JSONResponse(content=cached_data)
            response.headers["Cache-Control"] = (
                f"public, max-age={int(BULK_CACHE_TIMEOUT - cache_age)}"
            )
            response.headers["ETag"] = f"thread-{thread_id}-{int(cache_time)}"
            print__chat_all_messages_one_thread_debug(
                "🔍 CHAT_SINGLE_THREAD ENDPOINT - CACHE HIT EXIT"
            )
            return response
        else:
            print__chat_all_messages_one_thread_debug(
                f"⏰ CACHE EXPIRED: Cached data too old ({cache_age:.1f}s), will refresh"
            )
            del _bulk_loading_cache[cache_key]
            print__chat_all_messages_one_thread_debug("🔍 Expired cache entry deleted")
    else:
        print__chat_all_messages_one_thread_debug("🔍 No cache entry found for thread")

    # Use a lock to prevent multiple simultaneous requests for the same thread
    lock_key = f"{thread_id}_{user_email}"
    print__chat_all_messages_one_thread_debug(
        f"🔍 Attempting to acquire lock for thread: {lock_key}"
    )
    async with _bulk_loading_locks[lock_key]:
        print__chat_all_messages_one_thread_debug(
            f"🔒 Lock acquired for thread: {lock_key}"
        )

        # Double-check cache after acquiring lock (another request might have completed)
        if cache_key in _bulk_loading_cache:
            print__chat_all_messages_one_thread_debug(
                "🔍 Double-checking cache after lock acquisition"
            )
            cached_data, cache_time = _bulk_loading_cache[cache_key]
            cache_age = current_time - cache_time
            if cache_age < BULK_CACHE_TIMEOUT:
                print__chat_all_messages_one_thread_debug(
                    f"✅ CACHE HIT (after lock): Returning cached thread data for {thread_id}"
                )
                print__chat_all_messages_one_thread_debug(
                    "🔍 CHAT_SINGLE_THREAD ENDPOINT - CACHE HIT AFTER LOCK EXIT"
                )
                return cached_data
            else:
                print__chat_all_messages_one_thread_debug(
                    "🔍 Cache still expired after lock, proceeding with fresh request"
                )

        print__chat_all_messages_one_thread_debug(
            f"🔄 CACHE MISS: Processing fresh request for thread: {thread_id}"
        )

        # Simple memory check before starting
        print__chat_all_messages_one_thread_debug("🔍 Starting memory check")
        log_memory_usage("single_thread_start")
        print__chat_all_messages_one_thread_debug("🔍 Memory check completed")

        try:
            print__chat_all_messages_one_thread_debug("🔍 Getting healthy checkpointer")
            checkpointer = await get_healthy_checkpointer()
            print__chat_all_messages_one_thread_debug(
                f"🔍 Checkpointer obtained: {type(checkpointer).__name__}"
            )

            # STEP 1: Get run-ids and sentiments for this specific thread
            print__chat_all_messages_one_thread_debug(
                f"🔍 SINGLE THREAD QUERY: Getting run-ids and sentiments for thread: {thread_id}"
            )
            thread_run_ids = []
            thread_sentiments = {}

            # Get run-ids and sentiments for the specific thread
            print__chat_all_messages_one_thread_debug("🔍 Getting direct connection")
            print__chat_all_messages_one_thread_debug(
                "🔍 Using direct connection context manager"
            )
            async with get_direct_connection() as conn:
                print__chat_all_messages_one_thread_debug(
                    f"🔍 Connection obtained: {type(conn).__name__}"
                )
                async with conn.cursor() as cur:
                    print__chat_all_messages_one_thread_debug(
                        "🔍 Cursor created, executing single thread query"
                    )
                    # Query for specific thread only
                    await cur.execute(
                        """
                        SELECT 
                            run_id, 
                            prompt, 
                            timestamp,
                            sentiment
                        FROM users_threads_runs 
                        WHERE email = %s AND thread_id = %s
                        ORDER BY timestamp ASC
                    """,
                        (user_email, thread_id),
                    )

                    print__chat_all_messages_one_thread_debug(
                        "🔍 Single thread query executed, fetching results"
                    )
                    rows = await cur.fetchall()
                    print__chat_all_messages_one_thread_debug(
                        f"🔍 Retrieved {len(rows)} rows from database for thread {thread_id}"
                    )

                for i, row in enumerate(rows):
                    print__chat_all_messages_one_thread_debug(
                        f"🔍 Processing row {i+1}/{len(rows)}"
                    )
                    run_id = row[0]  # run_id
                    prompt = row[1]  # prompt
                    timestamp = row[2]  # timestamp
                    sentiment = row[3]  # sentiment

                    print__chat_all_messages_one_thread_debug(
                        f"🔍 Row data: run_id={run_id}, prompt_length={len(prompt) if prompt else 0}"
                    )

                    # Build run-ids list
                    thread_run_ids.append(
                        {
                            "run_id": run_id,
                            "prompt": prompt,
                            "timestamp": timestamp.isoformat(),
                        }
                    )

                    # Build sentiments dictionary
                    if sentiment is not None:
                        thread_sentiments[run_id] = sentiment
                        print__chat_all_messages_one_thread_debug(
                            f"🔍 Added sentiment for run_id {run_id}: {sentiment}"
                        )

            print__chat_all_messages_one_thread_debug(
                f"📊 SINGLE THREAD: Found {len(thread_run_ids)} run_ids for thread {thread_id}"
            )
            print__chat_all_messages_one_thread_debug(
                f"📊 SINGLE THREAD: Found {len(thread_sentiments)} sentiments for thread {thread_id}"
            )

            if not thread_run_ids:
                print__chat_all_messages_one_thread_debug(
                    f"⚠ No data found for thread {thread_id} - returning empty result"
                )
                empty_result = {"messages": [], "runIds": [], "sentiments": {}}
                _bulk_loading_cache[cache_key] = (empty_result, current_time)
                print__chat_all_messages_one_thread_debug(
                    "🔍 CHAT_SINGLE_THREAD ENDPOINT - EMPTY RESULT EXIT"
                )
                return empty_result

            # STEP 2: Process the single thread (no loop needed)
            print__chat_all_messages_one_thread_debug(
                f"🔄 Processing single thread: {thread_id}"
            )

            # Use the new reusable function to get messages with metadata
            print__chat_all_messages_one_thread_debug(
                f"🔍 Using reusable function to get messages for thread: {thread_id}"
            )
            chat_messages = await get_thread_messages_with_metadata(
                checkpointer, thread_id, user_email, "single_thread_processing"
            )

            if not chat_messages:
                print__chat_all_messages_one_thread_debug(
                    f"⚠ No messages found for thread {thread_id} - returning empty result"
                )
                empty_result = {
                    "messages": [],
                    "runIds": thread_run_ids,
                    "sentiments": thread_sentiments,
                }
                _bulk_loading_cache[cache_key] = (empty_result, current_time)
                return empty_result

            print__chat_all_messages_one_thread_debug(
                f"✅ Processed {len(chat_messages)} messages for thread {thread_id}"
            )

            print__chat_all_messages_one_thread_debug(
                f"✅ SINGLE THREAD PROCESSING COMPLETE: {len(chat_messages)} messages"
            )

            # Simple memory check after completion
            print__chat_all_messages_one_thread_debug(
                "🔍 Starting post-completion memory check"
            )
            log_memory_usage("single_thread_complete")
            print__chat_all_messages_one_thread_debug(
                "🔍 Post-completion memory check completed"
            )

            # Convert all ChatMessage objects to dicts for JSON serialization
            chat_messages_serialized = [
                msg.model_dump() if hasattr(msg, "model_dump") else msg.dict()
                for msg in chat_messages
            ]

            result = {
                "messages": chat_messages_serialized,
                "runIds": thread_run_ids,
                "sentiments": thread_sentiments,
            }
            print__chat_all_messages_one_thread_debug(
                f"🔍 Result dictionary created with {len(result)} keys"
            )

            # Cache the result
            _bulk_loading_cache[cache_key] = (result, current_time)
            print__chat_all_messages_one_thread_debug(
                f"💾 CACHED: Single thread result for {thread_id} (expires in {BULK_CACHE_TIMEOUT}s)"
            )

            # Return with cache headers
            response = JSONResponse(content=result)
            response.headers["Cache-Control"] = f"public, max-age={BULK_CACHE_TIMEOUT}"
            response.headers["ETag"] = f"thread-{thread_id}-{int(current_time)}"
            print__chat_all_messages_one_thread_debug(
                "🔍 JSONResponse created with cache headers"
            )
            print__chat_all_messages_one_thread_debug(
                "🔍 CHAT_SINGLE_THREAD ENDPOINT - SUCCESSFUL EXIT"
            )
            return response

        except Exception as e:
            print__chat_all_messages_one_thread_debug(
                f"❌ SINGLE THREAD ERROR: Failed to process request for thread {thread_id}: {e}"
            )
            print__chat_all_messages_one_thread_debug(
                f"🔍 Main exception type: {type(e).__name__}"
            )
            print__chat_all_messages_one_thread_debug(
                f"Full error traceback: {traceback.format_exc()}"
            )

            # Return empty result but cache it briefly to prevent error loops
            empty_result = {"messages": [], "runIds": [], "sentiments": {}}
            _bulk_loading_cache[cache_key] = (empty_result, current_time)
            print__chat_all_messages_one_thread_debug(
                "🔍 Cached empty result due to error"
            )

            response = JSONResponse(content=empty_result, status_code=500)
            response.headers["Cache-Control"] = (
                "no-cache, no-store"  # Don't cache errors
            )
            print__chat_all_messages_one_thread_debug(
                "🔍 CHAT_SINGLE_THREAD ENDPOINT - ERROR EXIT"
            )
            return response
