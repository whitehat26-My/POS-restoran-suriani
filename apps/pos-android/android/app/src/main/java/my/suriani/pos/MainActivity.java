package my.suriani.pos;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins are not auto-discovered; the bridge has to be told
        // before it is created.
        registerPlugin(PrinterPlugin.class);
        registerPlugin(LocalServerPlugin.class);
        super.onCreate(savedInstanceState);

        // A till that sleeps mid-service is a till the cashier has to wake and
        // unlock while a queue watches. The tablet lives on mains power in the
        // hardware list precisely so this is safe.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
