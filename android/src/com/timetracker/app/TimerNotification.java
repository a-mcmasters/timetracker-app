package com.timetracker.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

/**
 * The ongoing "tracking" notification, and the receiver for its Pause/Resume and Stop buttons.
 * Button presses are queued as "kind:time:timerId:seq" (kind p/r/s) so the page can replay them at the
 * moment they happened, even if the app was closed. The native copy of the timer (id, title, base,
 * pausedAt) lets the receiver redraw the notification without the page; id "" means none is running.
 * All prefs access is locked on this class: the page calls in from the WebView's bridge thread.
 */
public class TimerNotification extends BroadcastReceiver {
    private static final int ID = 1;
    private static final String CHANNEL = "running";
    private static final String ACTION_PAUSE = "pause", ACTION_RESUME = "resume", ACTION_STOP = "stop";

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("notification", Context.MODE_PRIVATE);
    }

    private static NotificationManager manager(Context c) {
        return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    /** The page's timer state; ignored while presses are queued that the page hasn't applied yet (it would be stale). */
    static synchronized void showFromPage(Context c, String timerId, String title, long base, long pausedAt) {
        SharedPreferences p = prefs(c);
        if (!p.getString("events", "").isEmpty()) return;
        if (p.edit().putString("id", timerId).putString("title", title).putLong("base", base)
                .putLong("pausedAt", pausedAt).commit()) post(c);
    }

    static synchronized void clear(Context c) {
        prefs(c).edit().putString("id", "").commit();
        manager(c).cancel(ID);
    }

    /** Draws the notification from the saved native timer state. */
    private static void post(Context c) {
        SharedPreferences p = prefs(c);
        String timerId = p.getString("id", "");
        if (timerId.isEmpty()) { manager(c).cancel(ID); return; }
        long pausedAt = p.getLong("pausedAt", 0);
        boolean paused = pausedAt != 0;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            manager(c).createNotificationChannel(new NotificationChannel(CHANNEL, "Running timer", NotificationManager.IMPORTANCE_LOW));
            b = new Notification.Builder(c, CHANNEL);
        } else {
            b = new Notification.Builder(c);
        }
        Intent open = new Intent(c, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        b.setSmallIcon(paused ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play)
                .setContentTitle(p.getString("title", ""))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(!paused)
                .setUsesChronometer(!paused)
                .setWhen(p.getLong("base", 0))
                .setContentIntent(PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .addAction(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause,
                        paused ? "Resume" : "Pause", button(c, paused ? ACTION_RESUME : ACTION_PAUSE, timerId))
                .addAction(android.R.drawable.ic_delete, "Stop", button(c, ACTION_STOP, timerId));
        if (paused) b.setContentText("Paused");
        manager(c).notify(ID, b.build());
    }

    /** The timer id goes in the data URI so each timer gets its own PendingIntent (extras don't count for that). */
    private static PendingIntent button(Context c, String action, String timerId) {
        Intent i = new Intent(c, TimerNotification.class).setAction(action).setData(Uri.parse("timer:" + Uri.encode(timerId)));
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE);
    }

    /** The queued button presses, comma-separated. They stay queued until ackEvents. */
    static synchronized String peekEvents(Context c) {
        return prefs(c).getString("events", "");
    }

    /** Drops `applied` (an earlier peekEvents result) from the front of the queue, keeping presses made since. */
    static synchronized void ackEvents(Context c, String applied) {
        String events = prefs(c).getString("events", "");
        if (applied.isEmpty() || !events.startsWith(applied)) return;
        String rest = events.substring(applied.length());
        if (!rest.isEmpty() && !rest.startsWith(",")) return; // not on an event boundary
        prefs(c).edit().putString("events", rest.isEmpty() ? "" : rest.substring(1)).commit();
    }

    @Override
    public void onReceive(Context c, Intent intent) {
        synchronized (TimerNotification.class) {
            SharedPreferences p = prefs(c);
            String timerId = p.getString("id", "");
            Uri data = intent.getData();
            // A press for a timer that already stopped or was replaced (e.g. delivered late): ignore it.
            if (timerId.isEmpty() || data == null || !timerId.equals(data.getSchemeSpecificPart())) return;
            long now = System.currentTimeMillis();
            long base = p.getLong("base", now), pausedAt = p.getLong("pausedAt", 0);
            long seq = p.getLong("seq", 0) + 1;
            String action = intent.getAction();
            boolean stop = ACTION_STOP.equals(action);
            // A second tap on a button that hasn't redrawn yet: the timer is already in that state.
            if (ACTION_PAUSE.equals(action) && pausedAt != 0 || ACTION_RESUME.equals(action) && pausedAt == 0) return;
            String kind = stop ? "s" : pausedAt != 0 ? "r" : "p";
            String event = kind + ":" + now + ":" + timerId + ":" + seq;
            String events = p.getString("events", "");
            SharedPreferences.Editor e = p.edit().putLong("seq", seq)
                    .putString("events", events.isEmpty() ? event : events + "," + event);
            // Queue the press and update the native timer in one commit, so a crash can't leave them out of step.
            if (stop) e.putString("id", "");
            else if (pausedAt != 0) e.putLong("base", base + Math.max(0, now - pausedAt)).putLong("pausedAt", 0);
            else e.putLong("pausedAt", now);
            if (!e.commit()) return;
            post(c);
        }
        MainActivity a = MainActivity.current;
        if (a != null) a.applyNotificationActions(); // app still open in the background: apply right away
    }
}
