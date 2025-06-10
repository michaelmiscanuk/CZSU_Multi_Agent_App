"use client";
import InputBar from '@/components/InputBar';
import MessageArea from '@/components/MessageArea';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { v4 as uuidv4 } from 'uuid';
import { useSession, getSession, signOut } from "next-auth/react";

// Types for PostgreSQL-based chat management
interface ChatThreadMeta {
  thread_id: string;
  latest_timestamp: string;
  run_count: number;
  title?: string; // We'll derive this from the first message or set a default
}

interface ChatMessage {
  id: string;
  threadId: string;
  user: string;
  content: string;
  isUser: boolean;
  createdAt: number;
  error?: string;
  meta?: Record<string, any>;
  queriesAndResults?: [string, string][];
  isLoading?: boolean;
  startedAt?: number;
  isError?: boolean;
}

interface Message {
  id: number;
  content: string;
  isUser: boolean;
  type: string;
  isLoading?: boolean;
  selectionCode?: string | null;
  queriesAndResults?: [string, string][];
  meta?: {
    datasetUrl?: string;
    datasetCodes?: string[];  // Array of dataset codes actually used in queries
    sql?: string;
  };
}

const INITIAL_MESSAGE = [
  {
    id: 1,
    content: 'Hi there, how can I help you?',
    isUser: false,
    type: 'message'
  }
];

export default function ChatPage() {
  const { data: session, status, update } = useSession();
  const userEmail = session?.user?.email || null;
  
  // Show loading while session is being fetched
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <div className="text-gray-600">Loading your session...</div>
        </div>
      </div>
    );
  }
  
  // Redirect to login if not authenticated
  if (status === "unauthenticated" || !userEmail) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-gray-600 mb-4">Please sign in to access your chats</div>
          <button 
            onClick={() => window.location.href = '/api/auth/signin'}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Sign In
          </button>
        </div>
      </div>
    );
  }
  
  const [threads, setThreads] = useState<ChatThreadMeta[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentMessage, setCurrentMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [openSQLModalForMsgId, setOpenSQLModalForMsgId] = useState<string | null>(null);
  const [iteration, setIteration] = useState(0);
  const [maxIterations, setMaxIterations] = useState(2); // default fallback
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  
  // Track previous chatId and message count for scroll logic
  const prevChatIdRef = React.useRef<string | null>(null);
  const prevMsgCountRef = React.useRef<number>(1);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const sidebarRef = React.useRef<HTMLDivElement>(null);
  
  const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

  // PostgreSQL API functions
  const loadThreadsFromPostgreSQL = async () => {
    console.log('[ChatPage-PostgreSQL] 🔄 Loading threads from PostgreSQL for user:', userEmail);
    
    if (!userEmail) {
      console.log('[ChatPage-PostgreSQL] ❌ No user email, skipping thread load');
      return;
    }

    if (threadsLoading) {
      console.log('[ChatPage-PostgreSQL] ⏳ Threads already loading, skipping...');
      return;
    }

    setThreadsLoading(true);

    try {
      console.log('[ChatPage-PostgreSQL] 🔍 Getting fresh session for API call...');
      let freshSession = await getSession();
      
      console.log('[ChatPage-PostgreSQL] 📊 Session debug info:', {
        hasSession: !!freshSession,
        hasIdToken: !!freshSession?.id_token,
        userEmail: freshSession?.user?.email,
        sessionKeys: freshSession ? Object.keys(freshSession) : [],
        tokenPreview: freshSession?.id_token ? freshSession.id_token.slice(0, 50) + '...' : 'none'
      });
      
      if (!freshSession?.id_token) {
        console.log('[ChatPage-PostgreSQL] ❌ No valid session token');
        console.log('[ChatPage-PostgreSQL] 🔍 Session object:', freshSession);
        setThreadsLoaded(true);
        setThreadsLoading(false);
        return;
      }

      console.log('[ChatPage-PostgreSQL] 🔗 Making API call to load threads...');
      console.log('[ChatPage-PostgreSQL] 📍 API URL:', `${API_BASE}/chat-threads`);
      console.log('[ChatPage-PostgreSQL] 🔑 Using token:', freshSession.id_token.slice(0, 50) + '...');
      
      const response = await fetch(`${API_BASE}/chat-threads`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${freshSession.id_token}`
        }
      });

      console.log('[ChatPage-PostgreSQL] 📥 API Response received:', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: {
          'content-type': response.headers.get('content-type'),
          'content-length': response.headers.get('content-length')
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ChatPage-PostgreSQL] ❌ API Error Response:', errorText);
        throw new Error(`Failed to get chat threads: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const postgresThreads = await response.json();
      console.log('[ChatPage-PostgreSQL] ✅ Loaded threads from PostgreSQL:', postgresThreads);
      console.log('[ChatPage-PostgreSQL] 📊 Raw API response details:', {
        isArray: Array.isArray(postgresThreads),
        length: postgresThreads?.length || 0,
        firstItem: postgresThreads?.[0] || null,
        type: typeof postgresThreads
      });
      
      // Convert PostgreSQL format to our frontend format
      const convertedThreads: ChatThreadMeta[] = postgresThreads.map((t: any) => ({
        thread_id: t.thread_id,
        latest_timestamp: t.latest_timestamp,
        run_count: t.run_count,
        title: `Chat ${t.thread_id.slice(-8)}` // Default title, will be updated
      }));

      console.log('[ChatPage-PostgreSQL] 🔄 Converted threads:', convertedThreads);

      setThreads(convertedThreads);
      setThreadsLoaded(true);
      
      console.log('[ChatPage-PostgreSQL] 📊 Thread loading summary:');
      console.log(`  - Total threads loaded: ${convertedThreads.length}`);
      console.log(`  - User email: ${userEmail}`);
      console.log(`  - API Base: ${API_BASE}`);
      console.log(`  - Frontend state updated successfully`);
      
      // If no threads exist, automatically create a new one silently
      if (convertedThreads.length === 0) {
        console.log('[ChatPage-PostgreSQL] 📝 No threads found, auto-creating first chat silently');
        const newThreadId = uuidv4();
        
        // Create the thread object and add it to the list
        const firstThread: ChatThreadMeta = {
          thread_id: newThreadId,
          latest_timestamp: new Date().toISOString(),
          run_count: 0,
          title: 'New Chat'
        };
        
        setThreads([firstThread]);
        setActiveThreadId(newThreadId);
        setMessages([]); // Clear messages for new chat
        console.log('[ChatPage-PostgreSQL] ✅ Auto-created first thread:', newThreadId);
        console.log('[ChatPage-PostgreSQL] ℹ️ Thread will be created in PostgreSQL when first message is sent');
        
        // Focus input for immediate use
        setTimeout(() => inputRef.current?.focus(), 100);
        setThreadsLoading(false);
        return;
      }
      
      // If no active thread and we have threads, select the most recent one
      if (!activeThreadId && convertedThreads.length > 0) {
        setActiveThreadId(convertedThreads[0].thread_id);
        console.log('[ChatPage-PostgreSQL] 🎯 Auto-selected active thread:', convertedThreads[0].thread_id);
      }
      
    } catch (error) {
      console.error('[ChatPage-PostgreSQL] ❌ Error loading threads from PostgreSQL:', error);
      console.error('[ChatPage-PostgreSQL] 🔍 Error details:', {
        name: (error as Error)?.name || 'Unknown',
        message: (error as Error)?.message || String(error),
        stack: (error as Error)?.stack || 'No stack trace available'
      });
      
      setThreadsLoaded(true); // Still mark as loaded even on error
      
      // If error loading and no threads, create first chat anyway
      if (threads.length === 0) {
        console.log('[ChatPage-PostgreSQL] 📝 Error loading but no threads, auto-creating first chat silently');
        const newThreadId = uuidv4();
        
        // Create the thread object and add it to the list
        const firstThread: ChatThreadMeta = {
          thread_id: newThreadId,
          latest_timestamp: new Date().toISOString(),
          run_count: 0,
          title: 'New Chat'
        };
        
        setThreads([firstThread]);
        setActiveThreadId(newThreadId);
        setMessages([]);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    } finally {
      setThreadsLoading(false);
      console.log('[ChatPage-PostgreSQL] 🏁 Thread loading process completed');
    }
  };

  const deleteThreadFromPostgreSQL = async (threadId: string) => {
    console.log('[ChatPage-PostgreSQL] 🗑️ Deleting thread from PostgreSQL:', threadId);
    
    try {
      let freshSession = await getSession();
      if (!freshSession?.id_token) {
        console.log('[ChatPage-PostgreSQL] ❌ No valid session token for deletion');
        return false;
      }

      const response = await fetch(`${API_BASE}/chat/${threadId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${freshSession.id_token}`
        }
      });

      if (!response.ok) {
        console.error('[ChatPage-PostgreSQL] ❌ Failed to delete thread:', response.status);
        return false;
      }

      const result = await response.json();
      console.log('[ChatPage-PostgreSQL] ✅ Thread deleted from PostgreSQL:', result);
      return true;
      
    } catch (error) {
      console.error('[ChatPage-PostgreSQL] ❌ Error deleting thread:', error);
      return false;
    }
  };

  // Load threads from PostgreSQL when user email is available
  useEffect(() => {
    // Only attempt to load threads when session is authenticated and we have userEmail
    if (status !== "authenticated" || !userEmail) {
      console.log('[ChatPage-PostgreSQL] ⏳ Waiting for authentication... Status:', status, 'UserEmail:', !!userEmail);
      return;
    }
    
    if (!threadsLoaded && !threadsLoading) {
      console.log('[ChatPage-PostgreSQL] 🚀 Initial thread load triggered - authenticated user:', userEmail);
      loadThreadsFromPostgreSQL();
    }
  }, [status, userEmail, threadsLoaded, threadsLoading]);

  // Debug: log session changes
  useEffect(() => {
    console.log('[ChatPage-PostgreSQL] 🔍 Session status changed:', {
      status,
      userEmail: userEmail || 'not available',
      threadsLoaded,
      threadsLoading,
      threadsCount: threads.length
    });
  }, [status, userEmail, threadsLoaded, threadsLoading, threads.length]);

  // Load messages for active session from PostgreSQL checkpoints
  const loadMessagesFromCheckpoint = async (threadId: string) => {
    if (!userEmail || !threadId) {
      setMessages([]);
      return;
    }

    console.log('[ChatPage-PostgreSQL] 📄 Loading messages from checkpoint for thread:', threadId);
    
    try {
      let session = await getSession();
      if (!session?.id_token) {
        console.error('[ChatPage-PostgreSQL] ❌ No session token available');
        setMessages([]);
        return;
      }

      // Fix: Use the correct API_BASE URL instead of /api/
      let response = await fetch(`${API_BASE}/chat/${threadId}/messages`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.id_token}`
        }
      });

      // Handle token refresh if needed
      if (response.status === 401) {
        console.log('[ChatPage-PostgreSQL] 🔄 Token expired during message load, refreshing...');
        const refreshedSession = await update();
        if (!refreshedSession?.id_token) {
          console.error('[ChatPage-PostgreSQL] ❌ Failed to refresh token');
          setMessages([]);
          return;
        }
        
        response = await fetch(`${API_BASE}/chat/${threadId}/messages`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${refreshedSession.id_token}`
          }
        });
      }

      if (!response.ok) {
        console.error('[ChatPage-PostgreSQL] ❌ Failed to load messages:', response.status, response.statusText);
        const errorText = await response.text();
        console.error('[ChatPage-PostgreSQL] ❌ Error response body:', errorText);
        setMessages([]);
        return;
      }

      const chatMessages = await response.json();
      console.log('[ChatPage-PostgreSQL] ✅ Loaded messages from checkpoint:', chatMessages.length);
      
      if (Array.isArray(chatMessages)) {
        setMessages(chatMessages);
      } else {
        console.error('[ChatPage-PostgreSQL] ❌ Invalid response format - expected array, got:', typeof chatMessages);
        setMessages([]);
      }
      
    } catch (error) {
      console.error('[ChatPage-PostgreSQL] ❌ Error loading messages from checkpoint:', error);
      setMessages([]);
    }
  };

  // Load messages for active session (now using PostgreSQL checkpoints)
  useEffect(() => {
    if (!userEmail || !activeThreadId) {
      setMessages([]);
      return;
    }
    
    console.log('[ChatPage-PostgreSQL] 📄 Loading messages for thread:', activeThreadId);
    loadMessagesFromCheckpoint(activeThreadId);
  }, [userEmail, activeThreadId]);

  // Remember last active chat in localStorage
  useEffect(() => {
    if (activeThreadId) {
      localStorage.setItem('czsu-last-active-chat', activeThreadId);
      console.log('[ChatPage-PostgreSQL] 💾 Saved active thread to localStorage:', activeThreadId);
    }
  }, [activeThreadId]);

  // Restore last active chat on mount
  useEffect(() => {
    if (!userEmail) return;
    const lastActive = localStorage.getItem('czsu-last-active-chat');
    if (lastActive && threads.length > 0) {
      // Check if the last active thread still exists
      const threadExists = threads.some(t => t.thread_id === lastActive);
      if (threadExists) {
        setActiveThreadId(lastActive);
        console.log('[ChatPage-PostgreSQL] 🔄 Restored active thread from localStorage:', lastActive);
      } else {
        console.log('[ChatPage-PostgreSQL] ⚠️ Last active thread no longer exists, clearing localStorage');
        localStorage.removeItem('czsu-last-active-chat');
      }
    } else if (!activeThreadId && threads.length > 0) {
      setActiveThreadId(threads[0].thread_id);
      console.log('[ChatPage-PostgreSQL] 🎯 Auto-selected first available thread:', threads[0].thread_id);
    }
  }, [userEmail, threads.length]);

  // Auto-scroll sidebar to top when entering chat menu
  useEffect(() => {
    if (sidebarRef.current) {
      sidebarRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  // Auto-create first chat if none exist (after threads are loaded)
  useEffect(() => {
    if (!userEmail || !threadsLoaded) return;
    
    if (threads.length === 0) {
      console.log('[ChatPage-PostgreSQL] 🆕 No threads found, will create one on first message');
      // We'll create the thread automatically when the user sends their first message
    }
  }, [userEmail, threadsLoaded, threads.length]);

  // New chat
  const handleNewChat = async () => {
    if (!userEmail) return;
    
    // Prevent creating multiple empty chats
    const hasEmptyChat = threads.some(t => t.run_count === 0 || !t.run_count);
    if (hasEmptyChat) {
      console.log('[ChatPage-PostgreSQL] ⚠️ Empty chat already exists, not creating another');
      return;
    }
    
    console.log('[ChatPage-PostgreSQL] ➕ Creating new chat...');
    const newThreadId = uuidv4();
    
    // Create a new thread entry in the threads list
    const newThread: ChatThreadMeta = {
      thread_id: newThreadId,
      latest_timestamp: new Date().toISOString(),
      run_count: 0,
      title: `New Chat`
    };
    
    // Add to threads list and set as active
    setThreads(prev => [newThread, ...prev]);
    setActiveThreadId(newThreadId);
    setMessages([]); // Clear messages for new chat
    
    console.log('[ChatPage-PostgreSQL] ✅ New thread created and added to sidebar:', newThreadId);
    
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Rename chat - we'll implement this later as it needs thread metadata storage
  const handleRename = async (threadId: string, title: string) => {
    console.log('[ChatPage-PostgreSQL] ✏️ Chat renaming not yet implemented for PostgreSQL backend');
    // TODO: Implement thread title storage in PostgreSQL
    setEditingTitleId(null);
  };

  // Delete chat
  const handleDelete = async (threadId: string) => {
    if (!userEmail) return;
    
    console.log('[ChatPage-PostgreSQL] 🗑️ Deleting chat:', threadId);
    
    try {
      const success = await deleteThreadFromPostgreSQL(threadId);
      
      if (success) {
        console.log('[ChatPage-PostgreSQL] ✅ Thread deleted successfully, reloading thread list');
        
        // Reload threads from PostgreSQL
        await loadThreadsFromPostgreSQL();
        
        // If we deleted the active thread, switch to another one
        if (activeThreadId === threadId) {
          const remainingThreads = threads.filter(t => t.thread_id !== threadId);
          const newActiveThread = remainingThreads.length > 0 ? remainingThreads[0].thread_id : null;
          setActiveThreadId(newActiveThread);
          console.log('[ChatPage-PostgreSQL] 🎯 Switched to new active thread:', newActiveThread);
        }
      } else {
        console.error('[ChatPage-PostgreSQL] ❌ Failed to delete thread');
      }
    } catch (error) {
      console.error('[ChatPage-PostgreSQL] ❌ Error deleting chat:', error);
    }
  };

  // Send message
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userEmail || !currentMessage.trim()) return;
    
    console.log('[ChatPage-PostgreSQL] 📤 Sending message:', currentMessage.slice(0, 50) + '...');
    setIsLoading(true);
    
    let threadId = activeThreadId;
    
    // If no active thread OR no threads exist at all, create a new one
    // This ensures we always have a parent chat item for any question
    if (!threadId || threads.length === 0) {
      threadId = uuidv4();
      setActiveThreadId(threadId);
      console.log('[ChatPage-PostgreSQL] 🆕 Auto-created thread for message (ensuring parent chat item):', threadId);
    }

    // Store the current message and clear input immediately
    const userMessageContent = currentMessage;
    setCurrentMessage("");
    
    // Add optimistic UI updates - show user message and loading immediately
    const tempUserMessage: ChatMessage = {
      id: `temp-user-${Date.now()}`,
      threadId: threadId,
      user: userEmail,
      content: userMessageContent,
      isUser: true,
      createdAt: Date.now()
    };
    
    const tempLoadingMessage: ChatMessage = {
      id: `temp-ai-${Date.now()}`,
      threadId: threadId,
      user: 'AI',
      content: '',
      isUser: false,
      createdAt: Date.now(),
      isLoading: true,
      startedAt: Date.now()
    };
    
    setMessages(prev => [...prev, tempUserMessage, tempLoadingMessage]);

    try {
      let freshSession = await getSession();
      if (!freshSession?.id_token) {
        signOut();
        setIsLoading(false);
        return;
      }
      
      const API_URL = `${API_BASE}/analyze`;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freshSession.id_token}`
      };
      
      console.log('[ChatPage-PostgreSQL] 🚀 Calling analyze API with thread_id:', threadId);
      
      let response = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: userMessageContent, thread_id: threadId })
      });
      
      // Handle token refresh if needed
      if (response.status === 401) {
        console.log('[ChatPage-PostgreSQL] 🔄 Token expired, refreshing...');
        const refreshedSession = await update();
        if (!refreshedSession?.id_token) {
          signOut();
          setIsLoading(false);
          return;
        }
        const retryHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${refreshedSession.id_token}`
        };
        response = await fetch(API_URL, {
          method: 'POST',
          headers: retryHeaders,
          body: JSON.stringify({ prompt: userMessageContent, thread_id: threadId })
        });
        if (response.status === 401) {
          signOut();
          setIsLoading(false);
          return;
        }
      }
      
      if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      console.log('[ChatPage-PostgreSQL] ✅ Received response, run_id:', data.run_id);
      
      // Instead of manually updating messages, reload from checkpoint
      // This ensures we get the complete conversation as stored by LangGraph
      console.log('[ChatPage-PostgreSQL] 🔄 Reloading messages from checkpoint after API response');
      
      // Add a small delay to ensure the checkpoint is fully written
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Reload messages from checkpoint
      await loadMessagesFromCheckpoint(threadId);
      
      // Reload threads to get updated information (this will show the newly created thread)
      console.log('[ChatPage-PostgreSQL] 🔄 Reloading threads after message sent');
      await loadThreadsFromPostgreSQL();
      
      // Show success message temporarily
      console.log('[ChatPage-PostgreSQL] 🎉 Message sent successfully');
      
    } catch (error) {
      console.error('[ChatPage-PostgreSQL] ❌ Error sending message:', error);
      
      // On error, still reload from checkpoint to get accurate state
      // Then add an error message if needed
      await loadMessagesFromCheckpoint(threadId);
      
      // Add a temporary error message
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        threadId: threadId,
        user: 'System',
        content: `Error: ${error}`,
        isUser: false,
        createdAt: Date.now(),
        isLoading: false,
        isError: true
      };
      
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // Debug: log session on mount and when it changes
  useEffect(() => {
    console.log('[ChatPage-PostgreSQL] 👤 Session updated:', JSON.stringify(session, null, 2));
  }, [session]);

  // Sync isLoading across tabs/windows
  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === 'czsu-chat-isLoading') {
        setIsLoading(e.newValue === 'true');
      }
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (isLoading) {
      localStorage.setItem('czsu-chat-isLoading', 'true');
    } else {
      localStorage.setItem('czsu-chat-isLoading', 'false');
    }
  }, [isLoading]);

  const handleSQLButtonClick = (msgId: string) => {
    setOpenSQLModalForMsgId(msgId);
  };

  const handleCloseSQLModal = () => {
    setOpenSQLModalForMsgId(null);
  };

  // UI
  return (
    <div className="chat-container flex w-full max-w-7xl mx-auto bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
      {/* Sidebar with its own scroll */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        {/* Sidebar Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white/80 backdrop-blur-sm">
          <span className="font-bold text-lg text-blue-700">Chats</span>
          <button
            className="px-3 py-1.5 rounded-full light-blue-theme text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleNewChat}
            title="New chat"
            disabled={isLoading || threads.some(s => !messages.length && s.thread_id === activeThreadId)}
          >
            + New Chat
          </button>
        </div>
        
        {/* Sidebar Chat List with Scroll */}
        <div ref={sidebarRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-1 chat-scrollbar">
          {threadsLoading ? (
            <div className="text-center py-8">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
              <div className="text-sm text-gray-500">Loading your chats...</div>
            </div>
          ) : threads.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-sm text-gray-500 mb-2">No chats yet</div>
              <div className="text-xs text-gray-400">Click "New Chat" to start</div>
            </div>
          ) : (
            threads.map(s => (
              <div key={s.thread_id} className="group">
                {editingTitleId === s.thread_id ? (
                  <input
                    className="w-full px-3 py-2 text-sm rounded-lg bg-white border border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    onBlur={() => handleRename(s.thread_id, newTitle)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(s.thread_id, newTitle); }}
                    autoFocus
                  />
                ) : (
                  <div className="flex items-center min-w-0">
                    <button
                      className={
                        `flex-1 text-left text-sm px-3 py-2 font-semibold rounded-lg transition-all duration-200 cursor-pointer min-w-0 ` +
                        (activeThreadId === s.thread_id
                          ? 'font-extrabold light-blue-theme '
                          : 'text-[#181C3A]/80 hover:text-gray-300 hover:bg-gray-100 ')
                      }
                      style={{fontFamily: 'var(--font-inter)'}}
                      onClick={() => setActiveThreadId(s.thread_id)}
                      onDoubleClick={() => { setEditingTitleId(s.thread_id); setNewTitle(s.title || ''); }}
                      title={`${s.title} (${s.run_count} messages)`}
                    >
                      <div className="truncate block">{s.title}</div>
                      <div className="text-xs text-gray-400 truncate">{s.run_count} messages</div>
                    </button>
                    <button
                      className="flex-shrink-0 ml-1 text-gray-400 hover:text-red-500 text-lg font-bold px-2 py-1 rounded transition-colors"
                      title="Delete chat"
                      onClick={() => handleDelete(s.thread_id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Chat Container */}
      <div className="flex-1 flex flex-col bg-gradient-to-br from-white to-blue-50/30 relative">
        {/* Chat Messages Area with its own scroll */}
        <div className="flex-1 overflow-hidden">
          <MessageArea
            messages={messages}
            threadId={activeThreadId}
            onSQLClick={handleSQLButtonClick}
            openSQLModalForMsgId={openSQLModalForMsgId}
            onCloseSQLModal={handleCloseSQLModal}
            onNewChat={handleNewChat}
            isLoading={isLoading}
          />
        </div>
        
        {/* Stationary Input Field */}
        <div className="bg-white border-t border-gray-200 shadow-lg">
          <form onSubmit={handleSend} className="p-4 flex items-center gap-3 max-w-4xl mx-auto">
            <input
              ref={inputRef}
              type="text"
              placeholder="Type your message here..."
              value={currentMessage}
              onChange={e => setCurrentMessage(e.target.value)}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-700 bg-gray-50 transition-all duration-200"
              disabled={isLoading}
            />
            <button
              type="submit"
              className="px-6 py-3 light-blue-theme rounded-xl font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200"
              disabled={isLoading || !currentMessage.trim()}
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-gray-400 border-t-gray-600 rounded-full animate-spin"></div>
                  Sending...
                </span>
              ) : (
                <span>Send</span>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
} 