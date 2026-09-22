package com.whopclip.agent

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.launch

/**
 * v6: extends platform android.app.Activity (not AppCompat).
 * Launch path is now: Application (trivial) -> Activity (trivial) ->
 * setContentView (plain LinearLayout). No WorkManager, no AppCompat on the
 * launch path. WorkManager initializes lazily via WorkHelper only when the
 * user taps "Automation start karo".
 */
class MainActivity : Activity() {

    private lateinit var statusText: TextView
    private lateinit var versionText: TextView
    private lateinit var serverInput: EditText
    private lateinit var pairInput: EditText

    companion object {
        private const val REQ_NOTIFICATIONS = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        versionText = findViewById(R.id.versionText)
        serverInput = findViewById(R.id.serverInput)
        pairInput = findViewById(R.id.pairInput)
        val whopBtn: Button = findViewById(R.id.whopLoginBtn)
        val igBtn: Button = findViewById(R.id.igLoginBtn)
        val saveBtn: Button = findViewById(R.id.saveServerBtn)
        val startBtn: Button = findViewById(R.id.startBtn)
        val pairBtn: Button = findViewById(R.id.pairBtn)

        // Android 13+: PollWorker's notifications are silently dropped
        // without this runtime grant. Ask once up front.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }

        serverInput.setText(SessionManager.serverUrl(this))

        whopBtn.setOnClickListener {
            startActivity(LoginActivity.intentFor(this, "whop"))
        }
        igBtn.setOnClickListener {
            startActivity(LoginActivity.intentFor(this, "instagram"))
        }
        saveBtn.setOnClickListener {
            val u = serverInput.text.toString().trim()
            if (u.isNotEmpty()) {
                SessionManager.setServerUrl(this, u)
                Toast.makeText(this, "Server save ho gaya", Toast.LENGTH_SHORT).show()
            }
        }
        startBtn.setOnClickListener {
            // Pairing gate: unpaired phone must not start polling.
            if (!SessionManager.isPaired(this)) {
                Toast.makeText(this, "Pehle pairing code se phone pair karo (website /connect se)",
                    Toast.LENGTH_LONG).show()
                pairInput.requestFocus()
                return@setOnClickListener
            }
            if (!SessionManager.isWhopLinked(this) || !SessionManager.isIgLinked(this)) {
                Toast.makeText(this, "Pehle Whop + Instagram dono me login karo",
                    Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            // Lazy WorkManager init — first and only touch at user action.
            if (!WorkHelper.ensure(this)) {
                Toast.makeText(this, "WorkManager start nahi hua — dobara try karo",
                    Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            PollService.start(this)
            Toast.makeText(this, "Automation polling start ✓", Toast.LENGTH_SHORT).show()
        }
        pairBtn.setOnClickListener {
            val code = pairInput.text.toString().trim()
            if (code.isEmpty()) {
                Toast.makeText(this, "Pairing code daalo (website /connect se)",
                    Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            pairBtn.isEnabled = false
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
                val ok = SessionManager.pairDevice(this@MainActivity, code)
                pairBtn.isEnabled = true
                if (ok) {
                    pairInput.text.clear()
                    Toast.makeText(this@MainActivity, "Phone pair ho gaya ✓",
                        Toast.LENGTH_SHORT).show()
                    refreshStatus()
                } else {
                    Toast.makeText(this@MainActivity,
                        "Pair nahi hua — code check karo (10 min expiry)",
                        Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val whop = if (SessionManager.isWhopLinked(this)) "✓ linked" else "✗ not linked"
        val ig = if (SessionManager.isIgLinked(this)) "✓ linked" else "✗ not linked"
        val paired = if (SessionManager.isPaired(this)) "✓ paired" else "✗ not paired"
        val wm = if (WorkHelper.isReady(this)) "✓ ok" else "– standby"
        val crash = (application as WhopClipApp).let { WhopClipApp.readCrashLog(it) }
        val crashLine = if (crash != null) "\n⚠ pichla crash: ${crash.lines().firstOrNull { it.isNotBlank() } ?: ""}" else ""
        statusText.text = "Whop: $whop\nInstagram: $ig\nPairing: $paired\nWorkManager: $wm\nDevice: ${SessionManager.deviceId(this).take(8)}…$crashLine"
        versionText.text = "v${appVersionName()} (${SessionManager.appVersionCode(this)})"
    }

    @Suppress("DEPRECATION")
    private fun appVersionName(): String = try {
        val pi = packageManager.getPackageInfo(packageName, 0)
        pi.versionName ?: "?"
    } catch (_: Exception) { "?" }
}
