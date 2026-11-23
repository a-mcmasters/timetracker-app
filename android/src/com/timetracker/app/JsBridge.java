package com.timetracker.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Methods callable from JavaScript as window.AndroidBridge.*. */
public class JsBridge {
    private final MainActivity activity;
    private boolean askedPermission;

    JsBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** Saves a text file (the CSV export) to the phone's Downloads folder. */
    @JavascriptInterface
    public void saveFile(String filename, String content) {
        String safeName = filename.replaceAll("[^A-Za-z0-9._-]", "_");
        OutputStream out = null;
        try {
            byte[] bytes = content.getBytes("UTF-8");
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                v.put(MediaStore.Downloads.MIME_TYPE, "text/csv");
                ContentResolver r = activity.getContentResolver();
                Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("could not create file");
                out = r.openOutputStream(uri);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                dir.mkdirs();
                out = new FileOutputStream(new File(dir, safeName));
            }
            out.write(bytes);
            activity.toast("Saved to Downloads: " + safeName);
        } catch (Exception e) {
            activity.toast("Export failed: " + e.getMessage());
        } finally {
            if (out != null) {
                try { out.close(); } catch (Exception ignored) { }
            }
        }
    }

    /** Shows (or updates) the running-timer notification; see TimerNotification.showFromPage. */
    @JavascriptInterface
    public void showRunning(String timerId, String title, double base, double pausedAt) {
        if (Build.VERSION.SDK_INT >= 33 && !askedPermission
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askedPermission = true;
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0);
                }
            });
        }
        TimerNotification.showFromPage(activity, timerId, title, (long) base, (long) pausedAt);
    }

    @JavascriptInterface
    public void clearRunning() {
        TimerNotification.clear(activity);
    }

    /** Queued Pause/Resume/Stop presses from the notification, as "kind:time:timerId:seq", comma-separated. */
    @JavascriptInterface
    public String peekNotificationEvents() {
        return TimerNotification.peekEvents(activity);
    }

    /** Called once the page has saved the result of applying `events` (a peekNotificationEvents result). */
    @JavascriptInterface
    public void ackNotificationEvents(String events) {
        TimerNotification.ackEvents(activity, events);
    }
}
