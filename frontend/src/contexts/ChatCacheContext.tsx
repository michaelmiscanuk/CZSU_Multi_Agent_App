'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'

// Types
interface ChatThreadMeta {
  thread_id: string;
  latest_timestamp: string;
  run_count: number;
  title: string;
  full_prompt: string;
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

interface CacheData {
  threads: ChatThreadMeta[];
  messages: { [threadId: string]: ChatMessage[] };
  activeThreadId: string | null;
  lastUpdated: number;
  userEmail: string | null;
}

interface ChatCacheContextType {
  // State
  threads: ChatThreadMeta[];
  messages: ChatMessage[];
  activeThreadId: string | null;
  isLoading: boolean;
  
  // Actions
  setThreads: (threads: ChatThreadMeta[]) => void;
  setMessages: (threadId: string, messages: ChatMessage[]) => void;
  setActiveThreadId: (threadId: string | null) => void;
  addMessage: (threadId: string, message: ChatMessage) => void;
  updateMessage: (threadId: string, messageId: string, updatedMessage: ChatMessage) => void;
  addThread: (thread: ChatThreadMeta) => void;
  removeThread: (threadId: string) => void;
  updateThread: (threadId: string, updates: Partial<ChatThreadMeta>) => void;
  
  // Cache management
  invalidateCache: () => void;
  refreshFromAPI: () => Promise<void>;
  isDataStale: () => boolean;
  
  // Load state
  setLoading: (loading: boolean) => void;
  
  // NEW: Track if this is a page refresh
  isPageRefresh: boolean;
  
  // NEW: Force API refresh on F5
  forceAPIRefresh: () => Promise<void>;
}

const ChatCacheContext = createContext<ChatCacheContextType | undefined>(undefined)

// Cache configuration
const CACHE_KEY = 'czsu-chat-cache'
const ACTIVE_THREAD_KEY = 'czsu-last-active-chat'
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes in milliseconds
const PAGE_REFRESH_FLAG_KEY = 'czsu-page-refresh-flag'

export function ChatCacheProvider({ children }: { children: React.ReactNode }) {
  // Internal state
  const [threads, setThreadsState] = useState<ChatThreadMeta[]>([])
  const [messages, setMessagesState] = useState<{ [threadId: string]: ChatMessage[] }>({})
  const [activeThreadId, setActiveThreadIdState] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number>(0)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isPageRefresh, setIsPageRefresh] = useState(false)
  
  // Track if this is the initial mount to detect page refresh
  const isInitialMount = useRef(true)
  const hasBeenHydrated = useRef(false)

  // Page refresh detection logic - fix to distinguish F5 from navigation
  useEffect(() => {
    console.log('[ChatCache] 🔄 Component mounted, checking if page refresh...');
    
    const now = Date.now();
    
    // More robust page refresh detection
    const isPageReload = () => {
      // Method 1: Performance navigation API (most reliable)
      if (performance.navigation && performance.navigation.type === 1) {
        return true;
      }
      
      // Method 2: Performance getEntriesByType (modern browsers)
      if (performance.getEntriesByType) {
        const entries = performance.getEntriesByType('navigation');
        if (entries.length > 0) {
          const navigationEntry = entries[0] as PerformanceNavigationTiming;
          if (navigationEntry.type === 'reload') {
            return true;
          }
        }
      }
      
      // Method 3: Check sessionStorage flag that persists only during session
      const refreshTimestamp = sessionStorage.getItem(PAGE_REFRESH_FLAG_KEY);
      
      if (refreshTimestamp) {
        const timeDiff = now - parseInt(refreshTimestamp, 10);
        // If less than 1 second since flag was set, it's likely a reload
        if (timeDiff < 1000) {
          return true;
        }
      }
      
      return false;
    };

    // Check if localStorage has data (previous session)
    const hasLocalStorageData = !!localStorage.getItem(CACHE_KEY);
    
    // Final decision logic - be more conservative about detecting refresh
    const actualPageRefresh = isPageReload();
    
    // Only set page refresh if we're confident it's a real F5/reload
    const finalDecision = actualPageRefresh && hasLocalStorageData;
    
    console.log('[ChatCache] 🔍 Page refresh detection: ', {
      performanceNavType: performance.navigation?.type,
      performanceEntries: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type,
      sessionStorageFlag: !!sessionStorage.getItem(PAGE_REFRESH_FLAG_KEY),
      hasLocalStorageData,
      actualPageRefresh,
      finalDecision
    });
    
    setIsPageRefresh(finalDecision);
    
    // Set sessionStorage flag for next potential refresh detection
    sessionStorage.setItem(PAGE_REFRESH_FLAG_KEY, now.toString());
    
    // Load initial data
    if (finalDecision) {
      console.log('[ChatCache] 🔄 Real page refresh (F5) detected - will force API sync');
    } else {
      console.log('[ChatCache] 🔄 Navigation detected - loading from localStorage cache');
      loadFromStorage();
    }
  }, []);

  const loadFromStorage = useCallback(() => {
    try {
      const stored = localStorage.getItem(CACHE_KEY)
      const activeThread = localStorage.getItem(ACTIVE_THREAD_KEY)
      
      if (stored) {
        const data: CacheData = JSON.parse(stored)
        console.log('[ChatCache] 📤 Loaded from localStorage:', {
          threads: data.threads?.length || 0,
          totalMessages: Object.keys(data.messages || {}).length,
          activeThread: data.activeThreadId,
          lastUpdated: new Date(data.lastUpdated).toISOString(),
          userEmail: data.userEmail
        })
        
        setThreadsState(data.threads || [])
        setMessagesState(data.messages || {})
        setUserEmail(data.userEmail)
        
        // Restore active thread from either cache or separate storage
        const threadToActivate = activeThread || data.activeThreadId
        if (threadToActivate) {
          setActiveThreadIdState(threadToActivate)
        }
      }
    } catch (error) {
      console.error('[ChatCache] ❌ Error loading from localStorage:', error)
    }
  }, [])

  const saveToStorage = useCallback((data: Partial<CacheData>) => {
    if (!hasBeenHydrated.current) {
      console.log('[ChatCache] ⏳ Skipping save - not yet hydrated')
      return
    }

    try {
      const existingData = localStorage.getItem(CACHE_KEY)
      const existing: CacheData = existingData ? JSON.parse(existingData) : {
        threads: [],
        messages: {},
        activeThreadId: null,
        lastUpdated: 0,
        userEmail: null
      }

      const updated: CacheData = {
        ...existing,
        ...data,
        lastUpdated: Date.now()
      }

      localStorage.setItem(CACHE_KEY, JSON.stringify(updated))
      
      // Also save active thread separately for quick access
      if (data.activeThreadId !== undefined) {
        if (data.activeThreadId) {
          localStorage.setItem(ACTIVE_THREAD_KEY, data.activeThreadId)
        } else {
          localStorage.removeItem(ACTIVE_THREAD_KEY)
        }
      }

      console.log('[ChatCache] 💾 Saved to localStorage:', {
        threads: updated.threads?.length || 0,
        totalMessages: Object.keys(updated.messages || {}).length,
        activeThread: updated.activeThreadId,
        userEmail: updated.userEmail
      })
    } catch (error) {
      console.error('[ChatCache] ❌ Error saving to localStorage:', error)
    }
  }, [hasBeenHydrated])

  // Save data whenever state changes
  useEffect(() => {
    if (hasBeenHydrated.current) {
      saveToStorage({
        threads,
        messages,
        activeThreadId,
        userEmail
      })
    }
  }, [threads, messages, activeThreadId, userEmail, saveToStorage])

  // Actions
  const setThreads = useCallback((newThreads: ChatThreadMeta[]) => {
    console.log('[ChatCache] 🔄 Setting threads:', newThreads.length)
    setThreadsState(newThreads)
  }, [])

  const setMessages = useCallback((threadId: string, newMessages: ChatMessage[]) => {
    console.log('[ChatCache] 🔄 Setting messages for thread:', threadId, 'count:', newMessages.length)
    setMessagesState(prev => ({
      ...prev,
      [threadId]: newMessages
    }))
  }, [])

  const setActiveThreadId = useCallback((threadId: string | null) => {
    console.log('[ChatCache] 🔄 Setting active thread:', threadId)
    setActiveThreadIdState(threadId)
  }, [])

  const addMessage = useCallback((threadId: string, message: ChatMessage) => {
    console.log('[ChatCache] ➕ Adding message to thread:', threadId)
    setMessagesState(prev => ({
      ...prev,
      [threadId]: [...(prev[threadId] || []), message]
    }))
  }, [])

  const updateMessage = useCallback((threadId: string, messageId: string, updatedMessage: ChatMessage) => {
    console.log('[ChatCache] 📝 Updating message:', messageId, 'in thread:', threadId)
    setMessagesState(prev => ({
      ...prev,
      [threadId]: (prev[threadId] || []).map(msg => 
        msg.id === messageId ? updatedMessage : msg
      )
    }))
  }, [])

  const addThread = useCallback((thread: ChatThreadMeta) => {
    console.log('[ChatCache] ➕ Adding thread:', thread.thread_id)
    setThreadsState(prev => [thread, ...prev])
  }, [])

  const removeThread = useCallback((threadId: string) => {
    console.log('[ChatCache] ➖ Removing thread:', threadId)
    setThreadsState(prev => prev.filter(t => t.thread_id !== threadId))
    setMessagesState(prev => {
      const newMessages = { ...prev }
      delete newMessages[threadId]
      return newMessages
    })
  }, [])

  const updateThread = useCallback((threadId: string, updates: Partial<ChatThreadMeta>) => {
    console.log('[ChatCache] 📝 Updating thread:', threadId, updates)
    setThreadsState(prev => prev.map(thread => 
      thread.thread_id === threadId ? { ...thread, ...updates } : thread
    ))
  }, [])

  const invalidateCache = useCallback(() => {
    console.log('[ChatCache] 🗑️ Invalidating cache')
    localStorage.removeItem(CACHE_KEY)
    localStorage.removeItem(ACTIVE_THREAD_KEY)
    setThreadsState([])
    setMessagesState({})
    setActiveThreadIdState(null)
    setUserEmail(null)
  }, [])

  const refreshFromAPI = useCallback(async () => {
    console.log('[ChatCache] 🔄 Manual refresh from API requested')
    // This will be implemented by the chat page
    // For now, just invalidate cache to force reload
    invalidateCache()
  }, [invalidateCache])

  const forceAPIRefresh = useCallback(async () => {
    console.log('[ChatCache] 🔄 Force API refresh (F5) - clearing cache and forcing PostgreSQL sync')
    
    // Clear all cache data
    localStorage.removeItem(CACHE_KEY)
    localStorage.removeItem(ACTIVE_THREAD_KEY)
    
    // Reset state
    setThreadsState([])
    setMessagesState({})
    setActiveThreadIdState(null)
    
    // Mark that we need fresh data from API
    setIsLoading(true)
    
    console.log('[ChatCache] ✅ Cache cleared - ready for fresh API data')
  }, [])

  const isDataStale = useCallback(() => {
    // If this is a page refresh, always consider data stale to force API call
    if (isPageRefresh) {
      console.log('[ChatCache] 🔍 Data is stale (page refresh detected)')
      return true
    }
    
    try {
      const stored = localStorage.getItem(CACHE_KEY)
      if (!stored) {
        console.log('[ChatCache] 🔍 Data is stale (no cache)')
        return true
      }
      
      const data: CacheData = JSON.parse(stored)
      const age = Date.now() - data.lastUpdated
      const isStale = age > CACHE_DURATION
      
      console.log('[ChatCache] 🔍 Data staleness check:', {
        age: Math.round(age / 1000),
        maxAge: Math.round(CACHE_DURATION / 1000),
        isStale
      })
      
      return isStale
    } catch (error) {
      console.error('[ChatCache] ❌ Error checking staleness:', error)
      return true
    }
  }, [isPageRefresh])

  const setLoading = useCallback((loading: boolean) => {
    setIsLoading(loading)
  }, [])

  // Get current messages for active thread
  const currentMessages = activeThreadId ? messages[activeThreadId] || [] : []

  const contextValue: ChatCacheContextType = {
    // State
    threads,
    messages: currentMessages,
    activeThreadId,
    isLoading,
    
    // Actions
    setThreads,
    setMessages,
    setActiveThreadId,
    addMessage,
    updateMessage,
    addThread,
    removeThread,
    updateThread,
    
    // Cache management
    invalidateCache,
    refreshFromAPI,
    isDataStale,
    setLoading,
    
    // NEW: Track if this is a page refresh
    isPageRefresh,
    
    // NEW: Force API refresh on F5
    forceAPIRefresh
  }

  return (
    <ChatCacheContext.Provider value={contextValue}>
      {children}
    </ChatCacheContext.Provider>
  )
}

export function useChatCache() {
  const context = useContext(ChatCacheContext)
  if (context === undefined) {
    throw new Error('useChatCache must be used within a ChatCacheProvider')
  }
  return context
} 