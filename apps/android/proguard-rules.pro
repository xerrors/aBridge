-assumenosideeffects interface org.slf4j.Logger {
    boolean isTraceEnabled(...) return false;
    void trace(...);
    boolean isDebugEnabled(...) return false;
    void debug(...);
    boolean isInfoEnabled(...) return false;
    void info(...);
    boolean isWarnEnabled(...) return false;
    void warn(...);
    boolean isErrorEnabled(...) return false;
    void error(...);
}
-assumenosideeffects class org.slf4j.LoggerFactory {
    static org.slf4j.Logger getLogger(...);
}
