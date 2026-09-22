package com.whopclip.agent

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Bridge between JobEngine's "upload" step and JobRunnerActivity's
 * onShowFileChooser. The engine clicks the <input type=file>; the
 * activity shows the system picker; the result is signalled here.
 *
 * Headless PollWorker has no activity -> awaitFile returns false ->
 * engine throws needs_foreground -> worker requeues the job and
 * notifies the user to open the app.
 */
object UploadBridge {
    @Volatile private var latch: CountDownLatch? = null
    @Volatile var fileChosen: Boolean = false
        private set

    fun arm() {
        fileChosen = false
        latch = CountDownLatch(1)
    }

    fun signal(chosen: Boolean) {
        fileChosen = chosen
        latch?.countDown()
    }

    /** true if the user picked a file within the timeout. */
    fun awaitFile(timeoutMs: Long): Boolean {
        val l = latch ?: return false
        return try {
            l.await(timeoutMs, TimeUnit.MILLISECONDS) && fileChosen
        } catch (e: InterruptedException) {
            false
        }
    }
}
