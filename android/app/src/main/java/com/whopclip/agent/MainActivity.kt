package com.whopclip.agent

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Home screen: shows link status for Whop + Instagram, buttons to
 * (re)login, server URL config, and start/stop of background polling.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var serverInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        serverInput = findViewById(R.id.serverInput)
        val whopBtn: Button = findViewById(R.id.whopLoginBtn)
        val igBtn: Button = findViewById(R.id.igLoginBtn)
        val saveBtn: Button = findViewById(R.id.saveServerBtn)
        val startBtn: Button = findViewById(R.id.startBtn)

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
            if (!SessionManager.isWhopLinked(this) || !SessionManager.isIgLinked(this)) {
                Toast.makeText(this, "Pehle Whop + Instagram dono me login karo",
                    Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            PollService.start(this)
            Toast.makeText(this, "Automation polling start ✓", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onResume() {
        super.onResume()
        val whop = if (SessionManager.isWhopLinked(this)) "✓ linked" else "✗ not linked"
        val ig = if (SessionManager.isIgLinked(this)) "✓ linked" else "✗ not linked"
        statusText.text = "Whop: $whop\nInstagram: $ig\nDevice: ${SessionManager.deviceId(this).take(8)}…"
        checkStaleSessions()
    }

    /** Checkpoint 10 — server flagged a session expired -> prompt re-login. */
    private fun checkStaleSessions() {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            try {
                val deviceId = SessionManager.deviceId(this@MainActivity)
                val url = "${SessionManager.serverUrl(this@MainActivity)}/api/sessions/status?device_id=$deviceId"
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000; readTimeout = 15000
                }
                val body = try {
                    if (conn.responseCode != 200) return@launch
                    JSONObject(conn.inputStream.bufferedReader().readText())
                } finally { conn.disconnect() }
                val services = body.optJSONObject("services") ?: return@launch
                val stale = mutableListOf<String>()
                if (services.optJSONObject("whop")?.optBoolean("stale") == true) stale.add("Whop")
                if (services.optJSONObject("instagram")?.optBoolean("stale") == true) stale.add("Instagram")
                if (stale.isNotEmpty()) {
                    runOnUiThread {
                        Toast.makeText(
                            this@MainActivity,
                            "${stale.joinToString(" + ")} session expire ho gaya — dobara login karo",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            } catch (_: Exception) { /* offline: ignore */ }
        }
    }
}
