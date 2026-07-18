<?php
/**
 * Plugin Name: AlmondShipping - Nigerian Shipping Rates
 * Description: Market-ready WooCommerce shipping method for Nigerian delivery rates with Mile 2 based Lagos pricing, state rates, admin management, and checkout area autosuggest.
 * Version: 1.0.0
 * Requires at least: 6.2
 * Requires PHP: 7.4
 * WC requires at least: 7.0
 * WC tested up to: 9.9
 * Author: Almond Systems
 * Author URI: https://almondsystems.com.ng/
 * License: GPLv2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: almondshipping-nigerian-shipping-rates
 * Domain Path: /languages
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) {
    exit;
}

define('ALMONDSHIPPING_VERSION', '1.0.0');
define('ALMONDSHIPPING_FILE', __FILE__);
define('ALMONDSHIPPING_DIR', plugin_dir_path(__FILE__));
define('ALMONDSHIPPING_URL', plugin_dir_url(__FILE__));

final class AlmondShipping_Plugin {
    private static $instance = null;

    public static function instance(): self {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('before_woocommerce_init', array($this, 'declare_wc_compatibility'));
        add_filter('woocommerce_shipping_methods', array($this, 'register_shipping_methods'));
        add_action('woocommerce_init', array($this, 'maybe_bootstrap_shipping_zone'));
        add_action('admin_init', array($this, 'maybe_bootstrap_shipping_zone'));
        add_filter('woocommerce_checkout_fields', array($this, 'add_checkout_fields'));
        add_action('woocommerce_after_checkout_billing_form', array($this, 'render_area_datalist'));
        add_action('woocommerce_checkout_update_order_review', array($this, 'capture_checkout_area'));
        add_action('woocommerce_after_checkout_validation', array($this, 'validate_checkout_area'), 10, 2);
        add_action('woocommerce_checkout_create_order', array($this, 'save_order_area'), 10, 2);
        add_action('wp_enqueue_scripts', array($this, 'enqueue_checkout_assets'));
        add_action('admin_menu', array($this, 'register_admin_menu'));
        add_action('admin_enqueue_scripts', array($this, 'enqueue_admin_assets'));
    }

    public function declare_wc_compatibility(): void {
        if (class_exists('Automattic\\WooCommerce\\Utilities\\FeaturesUtil')) {
            Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
            Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, false);
        }
    }

    public static function table_name(): string {
        global $wpdb;
        return $wpdb->prefix . 'almondshipping_rates';
    }

    public static function activate(): void {
        self::migrate();
        self::seed_rates(false);
        update_option('almondshipping_version', ALMONDSHIPPING_VERSION, false);
        update_option('almondshipping_bootstrap_zone', 'yes', false);
        self::flush_rates_cache();
    }

    public static function migrate(): void {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = self::table_name();
        $charset = $wpdb->get_charset_collate();
        dbDelta("CREATE TABLE {$table} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            rate_type varchar(24) NOT NULL,
            code varchar(40) NOT NULL DEFAULT '',
            label varchar(140) NOT NULL,
            amount decimal(12,2) NOT NULL DEFAULT 0.00,
            enabled tinyint(1) NOT NULL DEFAULT 1,
            sort_order int(11) NOT NULL DEFAULT 0,
            created_at datetime NOT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (id),
            KEY rate_lookup (rate_type,code),
            KEY enabled_sort (enabled,sort_order)
        ) {$charset};");
    }

    public static function default_lagos_rates(): array {
        return array(
            'Mile 2' => 2500, 'Ikeja' => 3000, 'Maryland' => 3000, 'Gbagada' => 3000,
            'Surulere' => 3000, 'Ogba' => 3500, 'Magodo' => 3500, 'Oshodi/Isolo' => 3500,
            'Victoria Island' => 4500, 'Ikoyi' => 4500, 'Lekki Phase 1' => 5000,
            'Chevron/VGC' => 5500, 'Ajah' => 6000, 'Ikorodu' => 6500,
            'Sangotedo' => 7000, 'Badagry' => 8000, 'Epe' => 8500,
            'Other Lagos Areas' => 5000,
        );
    }

    public static function default_state_rates(): array {
        return array(
            'AB' => 6500, 'FC' => 6000, 'AD' => 7500, 'AK' => 7500, 'AN' => 6500,
            'BA' => 8000, 'BY' => 8500, 'BE' => 7000, 'BO' => 9000, 'CR' => 7500,
            'DE' => 6500, 'EB' => 7000, 'ED' => 6500, 'EK' => 5500, 'EN' => 6500,
            'GO' => 8500, 'IM' => 6500, 'JI' => 8500, 'KD' => 7500, 'KN' => 8000,
            'KT' => 7500, 'KE' => 8500, 'KO' => 6500, 'KW' => 6500, 'NA' => 7000,
            'NI' => 7000, 'OG' => 4500, 'ON' => 5500, 'OS' => 5500, 'OY' => 5000,
            'PL' => 8000, 'RI' => 6500, 'SO' => 8000, 'TA' => 8500, 'YO' => 9000,
            'ZA' => 8500,
        );
    }

    public static function seed_rates(bool $force = false): void {
        global $wpdb;
        $table = self::table_name();
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Activation seeds a plugin-owned custom rates table.
        $exists = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM %i', $table));
        if ($exists > 0 && !$force) {
            return;
        }
        if ($force) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Resetting the plugin-owned custom rates table.
            $wpdb->query($wpdb->prepare('TRUNCATE TABLE %i', $table));
        }
        $now = current_time('mysql');
        $order = 0;
        foreach (self::default_lagos_rates() as $label => $amount) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Seeding the plugin-owned custom rates table.
            $wpdb->insert($table, array('rate_type' => 'lagos_area', 'code' => sanitize_title($label), 'label' => $label, 'amount' => $amount, 'enabled' => 1, 'sort_order' => $order++, 'created_at' => $now, 'updated_at' => $now));
        }
        $order = 0;
        foreach (self::default_state_rates() as $code => $amount) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Seeding the plugin-owned custom rates table.
            $wpdb->insert($table, array('rate_type' => 'state', 'code' => $code, 'label' => self::state_label($code), 'amount' => $amount, 'enabled' => 1, 'sort_order' => $order++, 'created_at' => $now, 'updated_at' => $now));
        }
        self::flush_rates_cache();
    }

    public static function normalize_state($state): string {
        $state = strtoupper(trim((string) $state));
        $aliases = array('LAGOS' => 'LA', 'LAGOS STATE' => 'LA', 'FCT' => 'FC', 'ABUJA' => 'FC', 'FEDERAL CAPITAL TERRITORY' => 'FC');
        return $aliases[$state] ?? $state;
    }

    public static function state_label(string $code): string {
        if (function_exists('WC') && WC() && WC()->countries) {
            $states = WC()->countries->get_states('NG');
            if (isset($states[$code])) {
                return $states[$code];
            }
        }
        return $code;
    }

    public static function rates(string $type, bool $enabled_only = true): array {
        global $wpdb;
        $cache_key = 'rates_' . md5($type . '|' . (int) $enabled_only);
        $cached = wp_cache_get($cache_key, 'almondshipping');
        if (false !== $cached) {
            return is_array($cached) ? $cached : array();
        }

        $table = self::table_name();
        if ($enabled_only) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Reading the plugin-owned custom rates table with object-cache coverage.
            $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM %i WHERE rate_type = %s AND enabled = %d ORDER BY sort_order ASC, label ASC', $table, $type, 1), ARRAY_A);
        } else {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- Reading the plugin-owned custom rates table with object-cache coverage.
            $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM %i WHERE rate_type = %s ORDER BY sort_order ASC, label ASC', $table, $type), ARRAY_A);
        }

        $rows = is_array($rows) ? $rows : array();
        wp_cache_set($cache_key, $rows, 'almondshipping', MINUTE_IN_SECONDS);
        return $rows;
    }

    private static function flush_rates_cache(): void {
        foreach (array('lagos_area', 'state') as $type) {
            wp_cache_delete('rates_' . md5($type . '|1'), 'almondshipping');
            wp_cache_delete('rates_' . md5($type . '|0'), 'almondshipping');
        }
    }

    public static function parse_rate_lines(string $raw, string $type): array {
        $items = array();
        foreach (preg_split('/\r\n|\r|\n/', $raw) as $line) {
            $line = trim($line);
            if ('' === $line || false === strpos($line, '=')) {
                continue;
            }
            list($label, $amount) = array_map('trim', explode('=', $line, 2));
            $amount = function_exists('wc_format_decimal') ? wc_format_decimal($amount) : $amount;
            if ('' === $label || !is_numeric($amount)) {
                continue;
            }
            $code = 'state' === $type ? self::normalize_state($label) : sanitize_title($label);
            $items[] = array('code' => $code, 'label' => 'state' === $type ? self::state_label($code) : $label, 'amount' => max(0, (float) $amount));
        }
        return $items;
    }

    public static function replace_rates(string $type, array $items): void {
        global $wpdb;
        $table = self::table_name();
        // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Updating the plugin-owned custom rates table from the admin rate editor.
        $wpdb->delete($table, array('rate_type' => $type), array('%s'));
        $now = current_time('mysql');
        foreach ($items as $order => $item) {
            // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- Updating the plugin-owned custom rates table from the admin rate editor.
            $wpdb->insert($table, array('rate_type' => $type, 'code' => sanitize_text_field($item['code']), 'label' => sanitize_text_field($item['label']), 'amount' => (float) $item['amount'], 'enabled' => 1, 'sort_order' => (int) $order, 'created_at' => $now, 'updated_at' => $now));
        }
        self::flush_rates_cache();
    }

    public static function match_lagos_area(string $value): ?array {
        $needle = strtolower(trim($value));
        if ('' === $needle) {
            return null;
        }
        foreach (self::rates('lagos_area') as $rate) {
            if ($needle === strtolower((string) $rate['label']) || $needle === strtolower((string) $rate['code'])) {
                return $rate;
            }
        }
        return null;
    }

    public function register_shipping_methods(array $methods): array {
        $methods['almondshipping_ng'] = 'AlmondShipping_Nigerian_Rates';
        $methods['bsn_ng_delivery'] = 'AlmondShipping_Legacy_BSN_Rates';
        return $methods;
    }

    public function maybe_bootstrap_shipping_zone(): void {
        if (!class_exists('WC_Shipping_Zones') || !class_exists('WC_Shipping_Zone') || 'yes' !== get_option('almondshipping_bootstrap_zone', 'yes')) {
            return;
        }
        $target_zone = null;
        foreach (WC_Shipping_Zones::get_zones() as $zone_data) {
            $zone = WC_Shipping_Zones::get_zone((int) $zone_data['id']);
            foreach ($zone->get_zone_locations() as $location) {
                if ('country' === $location->type && 'NG' === strtoupper($location->code)) {
                    $target_zone = $zone;
                    break 2;
                }
            }
        }
        if (!$target_zone) {
            $target_zone = new WC_Shipping_Zone();
            $target_zone->set_zone_name('Nigeria');
            $target_zone->set_zone_order(0);
            $target_zone->add_location('NG', 'country');
            $target_zone->save();
        }
        foreach ($target_zone->get_shipping_methods(false) as $method) {
            if (in_array($method->id, array('almondshipping_ng', 'bsn_ng_delivery'), true)) {
                update_option('almondshipping_bootstrap_zone', 'done', false);
                return;
            }
        }
        $target_zone->add_shipping_method('almondshipping_ng');
        update_option('almondshipping_bootstrap_zone', 'done', false);
    }

    public function add_checkout_fields(array $fields): array {
        $fields['billing']['billing_almondshipping_delivery_area'] = array(
            'type' => 'text',
            'label' => __('Delivery city / area', 'almondshipping-nigerian-shipping-rates'),
            'required' => false,
            'class' => array('form-row-wide', 'almondshipping-area-field'),
            'priority' => 82,
            'placeholder' => __('Start typing Mile 2, Ikeja, Lekki, Abuja...', 'almondshipping-nigerian-shipping-rates'),
            'description' => __('For Lagos deliveries, choose the closest matching area so AlmondShipping can apply the correct rate.', 'almondshipping-nigerian-shipping-rates'),
            'custom_attributes' => array('list' => 'almondshipping-delivery-areas', 'autocomplete' => 'off'),
        );
        return $fields;
    }

    public function render_area_datalist(): void {
        echo '<datalist id="almondshipping-delivery-areas">';
        foreach (self::rates('lagos_area') as $rate) {
            echo '<option value="' . esc_attr($rate['label']) . '">' . esc_html(wp_strip_all_tags(wc_price($rate['amount']))) . '</option>';
        }
        foreach (self::rates('state') as $rate) {
            echo '<option value="' . esc_attr($rate['label']) . '">' . esc_html__('State delivery', 'almondshipping-nigerian-shipping-rates') . '</option>';
        }
        echo '</datalist>';
    }

    public function capture_checkout_area(string $post_data): void {
        wp_parse_str($post_data, $posted);
        $state = !empty($posted['ship_to_different_address']) ? ($posted['shipping_state'] ?? '') : ($posted['billing_state'] ?? '');
        $area = sanitize_text_field($posted['billing_almondshipping_delivery_area'] ?? $posted['billing_bsn_lagos_area'] ?? '');
        if (WC()->session) {
            WC()->session->set('almondshipping_delivery_area', self::normalize_state($state) === 'LA' ? $area : '');
        }
    }

    public function validate_checkout_area(array $data, WP_Error $errors): void {
        $state = !empty($data['ship_to_different_address']) ? ($data['shipping_state'] ?? '') : ($data['billing_state'] ?? '');
        if (self::normalize_state($state) !== 'LA') {
            return;
        }
        $area = sanitize_text_field($data['billing_almondshipping_delivery_area'] ?? '');
        if ('' === $area) {
            $errors->add('almondshipping_area_required', __('Please enter your Lagos delivery city or area.', 'almondshipping-nigerian-shipping-rates'));
            return;
        }
        if (!self::match_lagos_area($area)) {
            $errors->add('almondshipping_area_match', __('Please choose a Lagos delivery area from the AlmondShipping suggestions.', 'almondshipping-nigerian-shipping-rates'));
        }
    }

    public function save_order_area($order, array $data): void {
        $area = sanitize_text_field($data['billing_almondshipping_delivery_area'] ?? '');
        if ('' !== $area && is_object($order) && method_exists($order, 'update_meta_data')) {
            $order->update_meta_data('_almondshipping_delivery_area', $area);
        }
    }

    public function enqueue_checkout_assets(): void {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return;
        }
        wp_enqueue_style('almondshipping-checkout', ALMONDSHIPPING_URL . 'assets/css/checkout.css', array(), ALMONDSHIPPING_VERSION);
        wp_enqueue_script('almondshipping-checkout', ALMONDSHIPPING_URL . 'assets/js/checkout.js', array('jquery', 'wc-checkout'), ALMONDSHIPPING_VERSION, true);
    }

    public function register_admin_menu(): void {
        add_submenu_page('woocommerce', __('AlmondShipping Rates', 'almondshipping-nigerian-shipping-rates'), __('AlmondShipping', 'almondshipping-nigerian-shipping-rates'), 'manage_woocommerce', 'almondshipping', array($this, 'render_admin_page'));
    }

    public function enqueue_admin_assets(string $hook): void {
        if ('woocommerce_page_almondshipping' === $hook) {
            wp_enqueue_style('almondshipping-admin', ALMONDSHIPPING_URL . 'assets/css/admin.css', array(), ALMONDSHIPPING_VERSION);
        }
    }

    private function rates_to_lines(string $type): string {
        $lines = array();
        foreach (self::rates($type, false) as $rate) {
            $key = 'state' === $type ? $rate['code'] : $rate['label'];
            $lines[] = $key . '=' . (function_exists('wc_format_decimal') ? wc_format_decimal($rate['amount'], 0) : $rate['amount']);
        }
        return implode("\n", $lines);
    }

    public function render_admin_page(): void {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }
        if (isset($_POST['almondshipping_action']) && check_admin_referer('almondshipping_save_rates', 'almondshipping_nonce')) {
            $action = sanitize_text_field(wp_unslash($_POST['almondshipping_action']));
            if ('reset' === $action) {
                self::seed_rates(true);
                echo '<div class="notice notice-success"><p>' . esc_html__('AlmondShipping default Nigerian rates restored.', 'almondshipping-nigerian-shipping-rates') . '</p></div>';
            } else {
                $lagos_rates = isset($_POST['lagos_rates']) ? sanitize_textarea_field(wp_unslash($_POST['lagos_rates'])) : '';
                $state_rates = isset($_POST['state_rates']) ? sanitize_textarea_field(wp_unslash($_POST['state_rates'])) : '';
                self::replace_rates('lagos_area', self::parse_rate_lines($lagos_rates, 'lagos_area'));
                self::replace_rates('state', self::parse_rate_lines($state_rates, 'state'));
                echo '<div class="notice notice-success"><p>' . esc_html__('AlmondShipping rates saved.', 'almondshipping-nigerian-shipping-rates') . '</p></div>';
            }
        }
        $lagos_rates = self::rates('lagos_area');
        $state_rates = self::rates('state');
        ?>
        <div class="wrap almondshipping-admin">
            <div class="almondshipping-hero">
                <div>
                    <p class="almondshipping-kicker"><?php esc_html_e('Nigerian delivery pricing', 'almondshipping-nigerian-shipping-rates'); ?></p>
                    <h1><?php esc_html_e('AlmondShipping', 'almondshipping-nigerian-shipping-rates'); ?></h1>
                    <p><?php esc_html_e('Manage WooCommerce shipping rates for Lagos areas and Nigerian states. Mile 2 is seeded as the central Lagos base point.', 'almondshipping-nigerian-shipping-rates'); ?></p>
                </div>
                <div class="almondshipping-stat"><strong><?php echo esc_html(count($lagos_rates)); ?></strong><span><?php esc_html_e('Lagos areas', 'almondshipping-nigerian-shipping-rates'); ?></span></div>
                <div class="almondshipping-stat"><strong><?php echo esc_html(count($state_rates)); ?></strong><span><?php esc_html_e('State rates', 'almondshipping-nigerian-shipping-rates'); ?></span></div>
            </div>
            <form method="post" class="almondshipping-grid">
                <?php wp_nonce_field('almondshipping_save_rates', 'almondshipping_nonce'); ?>
                <input type="hidden" name="almondshipping_action" value="save" />
                <section class="almondshipping-panel">
                    <h2><?php esc_html_e('Lagos city and area rates', 'almondshipping-nigerian-shipping-rates'); ?></h2>
                    <p><?php esc_html_e('One entry per line. Use Area=Rate. Customers see these in the checkout autosuggest field.', 'almondshipping-nigerian-shipping-rates'); ?></p>
                    <textarea name="lagos_rates" spellcheck="false"><?php echo esc_textarea($this->rates_to_lines('lagos_area')); ?></textarea>
                </section>
                <section class="almondshipping-panel">
                    <h2><?php esc_html_e('Other Nigerian state rates', 'almondshipping-nigerian-shipping-rates'); ?></h2>
                    <p><?php esc_html_e('One entry per line. Use WooCommerce state code=Rate, for example FC=6000.', 'almondshipping-nigerian-shipping-rates'); ?></p>
                    <textarea name="state_rates" spellcheck="false"><?php echo esc_textarea($this->rates_to_lines('state')); ?></textarea>
                </section>
                <div class="almondshipping-actions">
                    <button type="submit" class="button button-primary button-hero"><?php esc_html_e('Save rates', 'almondshipping-nigerian-shipping-rates'); ?></button>
                    <button type="submit" name="almondshipping_action" value="reset" class="button button-secondary" onclick="return confirm('<?php echo esc_js(__('Restore the seeded Nigerian rates?', 'almondshipping-nigerian-shipping-rates')); ?>')"><?php esc_html_e('Restore defaults', 'almondshipping-nigerian-shipping-rates'); ?></button>
                </div>
            </form>
        </div>
        <?php
    }
}

function almondshipping_load_shipping_methods(): void {
    if (!class_exists('WC_Shipping_Method') || class_exists('AlmondShipping_Nigerian_Rates')) {
        return;
    }

    class AlmondShipping_Nigerian_Rates extends WC_Shipping_Method {
        protected $method_id = 'almondshipping_ng';

        public function __construct($instance_id = 0) {
            $this->id = $this->method_id;
            $this->instance_id = absint($instance_id);
            $this->method_title = __('AlmondShipping', 'almondshipping-nigerian-shipping-rates');
            $this->method_description = __('Nigerian delivery rates with Mile 2 as the Lagos base point and configurable state pricing.', 'almondshipping-nigerian-shipping-rates');
            $this->supports = array('shipping-zones', 'instance-settings', 'instance-settings-modal');
            $this->init();
        }

        public function init(): void {
            $this->init_form_fields();
            $this->init_settings();
            $this->enabled = $this->get_option('enabled', 'yes');
            $this->title = $this->get_option('title', __('AlmondShipping', 'almondshipping-nigerian-shipping-rates'));
            add_action('woocommerce_update_options_shipping_' . $this->id, array($this, 'process_admin_options'));
        }

        public function init_form_fields(): void {
            $this->instance_form_fields = array(
                'enabled' => array('title' => __('Enable', 'almondshipping-nigerian-shipping-rates'), 'type' => 'checkbox', 'label' => __('Enable AlmondShipping delivery rates', 'almondshipping-nigerian-shipping-rates'), 'default' => 'yes'),
                'title' => array('title' => __('Checkout label', 'almondshipping-nigerian-shipping-rates'), 'type' => 'text', 'description' => __('Shown to customers as the shipping method name at checkout.', 'almondshipping-nigerian-shipping-rates'), 'default' => __('AlmondShipping', 'almondshipping-nigerian-shipping-rates'), 'desc_tip' => true),
                'lagos_rate' => array('title' => __('Lagos fallback rate', 'almondshipping-nigerian-shipping-rates'), 'type' => 'number', 'custom_attributes' => array('step' => '1', 'min' => '0'), 'default' => '3000', 'description' => __('Used when Lagos is selected before a matching city or area is chosen.', 'almondshipping-nigerian-shipping-rates')),
                'outside_lagos_rate' => array('title' => __('Other states fallback rate', 'almondshipping-nigerian-shipping-rates'), 'type' => 'number', 'custom_attributes' => array('step' => '1', 'min' => '0'), 'default' => '6000', 'description' => __('Used when a Nigerian state has no configured override.', 'almondshipping-nigerian-shipping-rates')),
                'tax_status' => array('title' => __('Tax status', 'almondshipping-nigerian-shipping-rates'), 'type' => 'select', 'class' => 'wc-enhanced-select', 'default' => 'taxable', 'options' => array('taxable' => __('Taxable', 'almondshipping-nigerian-shipping-rates'), 'none' => _x('None', 'Tax status', 'almondshipping-nigerian-shipping-rates'))),
            );
            $this->form_fields = $this->instance_form_fields;
        }

        private function selected_area(): string {
            $area = '';
            if (WC()->session) {
                $area = (string) WC()->session->get('almondshipping_delivery_area', '');
            }
            $post_data = filter_input(INPUT_POST, 'post_data', FILTER_UNSAFE_RAW);
            if (!$area && is_string($post_data) && '' !== $post_data) {
                wp_parse_str($post_data, $posted);
                $area = sanitize_text_field($posted['billing_almondshipping_delivery_area'] ?? $posted['billing_bsn_lagos_area'] ?? '');
            }
            return $area;
        }

        public function calculate_shipping($package = array()): void {
            if ('yes' !== $this->enabled) {
                return;
            }
            $destination = $package['destination'] ?? array();
            $country = strtoupper((string) ($destination['country'] ?? ''));
            if ($country && 'NG' !== $country) {
                return;
            }
            $state = AlmondShipping_Plugin::normalize_state($destination['state'] ?? '');
            $label = $this->title;
            $cost = (float) $this->get_option('outside_lagos_rate', '6000');
            if ('LA' === $state || '' === $state) {
                $cost = (float) $this->get_option('lagos_rate', '3000');
                $area = AlmondShipping_Plugin::match_lagos_area($this->selected_area());
                if ($area) {
                    $cost = (float) $area['amount'];
                    /* translators: 1: shipping method title, 2: Lagos delivery area. */
                    $label = sprintf(__('%1$s to Lagos - %2$s', 'almondshipping-nigerian-shipping-rates'), $this->title, $area['label']);
                }
            } else {
                foreach (AlmondShipping_Plugin::rates('state') as $rate) {
                    if ($state === AlmondShipping_Plugin::normalize_state($rate['code'])) {
                        $cost = (float) $rate['amount'];
                        break;
                    }
                }
                /* translators: 1: shipping method title, 2: Nigerian state name. */
                $label = sprintf(__('%1$s to %2$s', 'almondshipping-nigerian-shipping-rates'), $this->title, AlmondShipping_Plugin::state_label($state));
            }
            $this->add_rate(array('id' => $this->get_rate_id(), 'label' => $label, 'cost' => max(0, $cost), 'calc_tax' => 'per_order'));
        }
    }

    class AlmondShipping_Legacy_BSN_Rates extends AlmondShipping_Nigerian_Rates {
        protected $method_id = 'bsn_ng_delivery';
    }
}

add_action('woocommerce_shipping_init', 'almondshipping_load_shipping_methods');
register_activation_hook(__FILE__, array('AlmondShipping_Plugin', 'activate'));
AlmondShipping_Plugin::instance();
