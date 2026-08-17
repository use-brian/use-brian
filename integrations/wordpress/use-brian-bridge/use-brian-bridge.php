<?php
/**
 * Plugin Name: Use Brian Bridge
 * Description: Exposes explicitly registered text and image slots to the Use Brian WordPress connector.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

final class Use_Brian_Managed_Content {
    const VERSION = '0.1.0';
    const NAMESPACE = 'use-brian/v1';
    const MAX_TEXT_BYTES = 20000;
    const MAX_ALT_BYTES = 500;
    const MAX_IMAGE_BYTES = 20971520;

    /** @var array<string,array<string,mixed>> */
    private static $pages = array();
    /** @var bool */
    private static $loaded = false;

    public static function register_page($id, $args) {
        if (!self::valid_id($id) || !is_array($args)) {
            return new WP_Error('invalid_managed_page', 'Managed page registration is invalid.');
        }
        if (isset(self::$pages[$id])) {
            return new WP_Error('duplicate_managed_page', 'Managed page ids must be unique.');
        }

        $label = isset($args['label']) ? sanitize_text_field($args['label']) : '';
        $url = isset($args['url']) ? esc_url_raw($args['url']) : '';
        if ($label === '' || $url === '') {
            return new WP_Error('invalid_managed_page', 'Managed pages require a label and public URL.');
        }

        self::$pages[$id] = array(
            'id' => $id,
            'label' => $label,
            'url' => $url,
            'page_id' => isset($args['page_id']) ? absint($args['page_id']) : 0,
            'read_capability' => self::capability($args, 'read_capability', 'edit_pages'),
            'slots' => array(),
        );
        return true;
    }

    public static function register_slot($page_id, $slot_id, $args) {
        if (!self::valid_id($page_id) || !self::valid_id($slot_id) || !is_array($args)) {
            return new WP_Error('invalid_managed_slot', 'Managed slot registration is invalid.');
        }
        if (!isset(self::$pages[$page_id])) {
            return new WP_Error('managed_page_not_found', 'Register the managed page before its slots.');
        }
        if (isset(self::$pages[$page_id]['slots'][$slot_id])) {
            return new WP_Error('duplicate_managed_slot', 'Managed slot ids must be unique within a page.');
        }

        $type = isset($args['type']) ? $args['type'] : '';
        $label = isset($args['label']) ? sanitize_text_field($args['label']) : '';
        $read = isset($args['read_callback']) ? $args['read_callback'] : null;
        $write = isset($args['write_callback']) ? $args['write_callback'] : null;
        if (!in_array($type, array('text', 'image'), true) || $label === '' || !is_callable($read) || !is_callable($write)) {
            return new WP_Error('invalid_managed_slot', 'Managed slots require a type, label, and callable read/write callbacks.');
        }

        $aliases = array();
        if (isset($args['aliases']) && is_array($args['aliases'])) {
            foreach (array_slice($args['aliases'], 0, 20) as $alias) {
                $clean = sanitize_text_field($alias);
                if ($clean !== '') {
                    $aliases[] = $clean;
                }
            }
        }

        $selector = isset($args['selector']) ? sanitize_text_field($args['selector']) : '';
        self::$pages[$page_id]['slots'][$slot_id] = array(
            'id' => $slot_id,
            'type' => $type,
            'label' => $label,
            'section' => isset($args['section']) ? sanitize_text_field($args['section']) : '',
            'aliases' => array_values(array_unique($aliases)),
            'selector' => $selector,
            'read_callback' => $read,
            'write_callback' => $write,
            'write_capability' => self::capability($args, 'write_capability', 'edit_pages'),
        );
        return true;
    }

    public static function register_routes() {
        register_rest_route(self::NAMESPACE, '/site', array(
            'methods' => WP_REST_Server::READABLE,
            'callback' => array(__CLASS__, 'get_site'),
            'permission_callback' => array(__CLASS__, 'can_read_site'),
        ));
        register_rest_route(self::NAMESPACE, '/managed-pages/(?P<page>[a-z][a-z0-9_-]{0,99})', array(
            'methods' => WP_REST_Server::READABLE,
            'callback' => array(__CLASS__, 'get_page'),
            'permission_callback' => array(__CLASS__, 'can_read_page'),
        ));
        register_rest_route(self::NAMESPACE, '/managed-pages/(?P<page>[a-z][a-z0-9_-]{0,99})/text/(?P<slot>[a-z][a-z0-9_-]{0,99})', array(
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => array(__CLASS__, 'update_text'),
            'permission_callback' => array(__CLASS__, 'can_write_slot'),
        ));
        register_rest_route(self::NAMESPACE, '/managed-pages/(?P<page>[a-z][a-z0-9_-]{0,99})/image/(?P<slot>[a-z][a-z0-9_-]{0,99})', array(
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => array(__CLASS__, 'replace_image'),
            'permission_callback' => array(__CLASS__, 'can_write_image'),
        ));
    }

    public static function can_read_site() {
        return current_user_can('edit_pages')
            ? true
            : self::error('forbidden', 'This account cannot edit pages.', 403);
    }

    public static function can_read_page($request) {
        $page = self::page($request['page']);
        if (is_wp_error($page)) {
            return $page;
        }
        return current_user_can($page['read_capability'])
            ? true
            : self::error('forbidden', 'This account cannot read the managed page.', 403);
    }

    public static function can_write_slot($request) {
        $slot = self::slot($request['page'], $request['slot']);
        if (is_wp_error($slot)) {
            return $slot;
        }
        return current_user_can($slot['write_capability'])
            ? true
            : self::error('forbidden', 'This account cannot update the managed location.', 403);
    }

    public static function can_write_image($request) {
        $allowed = self::can_write_slot($request);
        if (is_wp_error($allowed)) {
            return $allowed;
        }
        return current_user_can('upload_files')
            ? true
            : self::error('forbidden', 'This account cannot upload files.', 403);
    }

    public static function get_site() {
        self::load_catalog();
        return rest_ensure_response(array(
            'site_url' => home_url('/'),
            'name' => get_bloginfo('name'),
            'bridge_version' => self::VERSION,
            'managed_pages' => array_values(array_map(function ($page) {
                return array('id' => $page['id'], 'label' => $page['label'], 'url' => $page['url']);
            }, self::$pages)),
        ));
    }

    public static function get_page($request) {
        $page = self::page($request['page']);
        if (is_wp_error($page)) {
            return $page;
        }
        $snapshot = self::snapshot($page);
        return is_wp_error($snapshot) ? $snapshot : rest_ensure_response($snapshot);
    }

    public static function update_text($request) {
        $page = self::page($request['page']);
        $slot = self::slot($request['page'], $request['slot']);
        if (is_wp_error($page)) {
            return $page;
        }
        if (is_wp_error($slot)) {
            return $slot;
        }
        if ($slot['type'] !== 'text') {
            return self::error('wrong_slot_type', 'This managed location is not text.', 400);
        }

        $value = $request->get_param('value');
        $expected = $request->get_param('expected_revision');
        if (!is_string($value) || strlen($value) > self::MAX_TEXT_BYTES || !is_string($expected)) {
            return self::error('bridge_error', 'The text update payload is invalid.', 400);
        }
        $current = self::snapshot($page);
        if (is_wp_error($current)) {
            return $current;
        }
        if (!hash_equals($current['revision'], $expected)) {
            return self::error('revision_conflict', 'The page changed after it was read.', 409);
        }

        $result = self::call_write($slot, $value);
        if (is_wp_error($result)) {
            return $result;
        }
        do_action('use_brian_managed_slot_updated', $page['id'], $slot['id'], 'text', $value, null);
        $updated = self::snapshot($page);
        return is_wp_error($updated) ? $updated : rest_ensure_response($updated);
    }

    public static function replace_image($request) {
        $page = self::page($request['page']);
        $slot = self::slot($request['page'], $request['slot']);
        if (is_wp_error($page)) {
            return $page;
        }
        if (is_wp_error($slot)) {
            return $slot;
        }
        if ($slot['type'] !== 'image') {
            return self::error('wrong_slot_type', 'This managed location is not an image.', 400);
        }

        $expected_revision = $request->get_param('expected_revision');
        $expected_attachment_raw = $request->get_param('expected_attachment_id');
        if ($expected_attachment_raw === '' || $expected_attachment_raw === null) {
            $expected_attachment = null;
        } elseif (!is_scalar($expected_attachment_raw) || preg_match('/^[1-9][0-9]*$/', (string) $expected_attachment_raw) !== 1) {
            return self::error('bridge_error', 'The expected attachment id is invalid.', 400);
        } else {
            $expected_attachment = absint($expected_attachment_raw);
        }
        $alt_text = $request->get_param('alt_text');
        if (!is_string($expected_revision) || !is_string($alt_text) || strlen($alt_text) > self::MAX_ALT_BYTES) {
            return self::error('bridge_error', 'The image update payload is invalid.', 400);
        }

        $current = self::snapshot($page);
        if (is_wp_error($current)) {
            return $current;
        }
        if (!hash_equals($current['revision'], $expected_revision)) {
            return self::error('revision_conflict', 'The page changed after it was read.', 409);
        }
        $current_attachment = self::current_attachment_id($slot);
        if (is_wp_error($current_attachment)) {
            return $current_attachment;
        }
        if ($current_attachment !== $expected_attachment) {
            return self::error('attachment_conflict', 'The image changed after it was read.', 409);
        }

        $files = $request->get_file_params();
        if (!isset($files['file']) || !is_array($files['file'])) {
            return self::error('unsupported_image', 'An image file is required.', 400);
        }
        $upload = $files['file'];
        if (!isset($upload['size']) || (int) $upload['size'] <= 0) {
            return self::error('unsupported_image', 'The uploaded image is empty.', 400);
        }
        if ((int) $upload['size'] > self::MAX_IMAGE_BYTES) {
            return self::error('file_too_large', 'The image exceeds the connector limit.', 413);
        }

        $allowed_mimes = array(
            'jpg|jpeg|jpe' => 'image/jpeg',
            'png' => 'image/png',
            'webp' => 'image/webp',
        );
        $checked = wp_check_filetype_and_ext($upload['tmp_name'], $upload['name'], $allowed_mimes);
        if (empty($checked['type']) || !in_array($checked['type'], array_values($allowed_mimes), true)) {
            return self::error('unsupported_image', 'Only JPEG, PNG, and WebP images are supported.', 415);
        }

        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $attachment_id = media_handle_upload('file', $page['page_id']);
        if (is_wp_error($attachment_id)) {
            return self::error('bridge_error', 'WordPress could not create the Media Library attachment.', 500);
        }

        $written = self::call_write($slot, $attachment_id);
        if (is_wp_error($written)) {
            wp_delete_attachment($attachment_id, true);
            return $written;
        }
        update_post_meta($attachment_id, '_wp_attachment_image_alt', sanitize_text_field($alt_text));
        do_action('use_brian_managed_slot_updated', $page['id'], $slot['id'], 'image', $attachment_id, $current_attachment);

        $updated = self::snapshot($page);
        if (is_wp_error($updated)) {
            return $updated;
        }
        $updated['previous_attachment_id'] = $current_attachment;
        return rest_ensure_response($updated);
    }

    private static function load_catalog() {
        if (self::$loaded) {
            return;
        }
        self::$loaded = true;
        do_action('use_brian_register_managed_content');
    }

    private static function page($id) {
        self::load_catalog();
        return isset(self::$pages[$id])
            ? self::$pages[$id]
            : self::error('managed_page_not_found', 'That page is not managed.', 404);
    }

    private static function slot($page_id, $slot_id) {
        $page = self::page($page_id);
        if (is_wp_error($page)) {
            return $page;
        }
        return isset($page['slots'][$slot_id])
            ? $page['slots'][$slot_id]
            : self::error('managed_slot_not_found', 'That location is not managed.', 404);
    }

    private static function snapshot($page) {
        $slots = array();
        foreach ($page['slots'] as $slot) {
            $value = self::read_slot($slot);
            if (is_wp_error($value)) {
                return $value;
            }
            $slots[] = array_merge(array(
                'id' => $slot['id'],
                'type' => $slot['type'],
                'label' => $slot['label'],
                'section' => $slot['section'],
                'aliases' => $slot['aliases'],
                'selector' => $slot['selector'],
            ), $value);
        }
        $revision_values = array_map(function ($slot) {
            return array('id' => $slot['id'], 'type' => $slot['type'], 'value' => isset($slot['value']) ? $slot['value'] : null, 'attachment_id' => isset($slot['attachment_id']) ? $slot['attachment_id'] : null);
        }, $slots);
        return array(
            'page' => $page['id'],
            'page_id' => $page['page_id'],
            'label' => $page['label'],
            'url' => $page['url'],
            'revision' => hash('sha256', wp_json_encode($revision_values)),
            'slots' => $slots,
        );
    }

    private static function read_slot($slot) {
        try {
            $raw = call_user_func($slot['read_callback']);
        } catch (Throwable $error) {
            return self::error('bridge_error', 'The site could not read this managed location.', 500);
        }
        if (is_wp_error($raw)) {
            return self::error('bridge_error', 'The site could not read this managed location.', 500);
        }
        if ($slot['type'] === 'text') {
            return array('value' => is_scalar($raw) ? (string) $raw : '');
        }

        $attachment_id = ($raw === null || $raw === '') ? null : absint($raw);
        if (!$attachment_id) {
            return array('attachment_id' => null, 'url' => null, 'alt_text' => '', 'mime_type' => null, 'width' => null, 'height' => null);
        }
        $metadata = wp_get_attachment_metadata($attachment_id);
        return array(
            'attachment_id' => $attachment_id,
            'url' => wp_get_attachment_url($attachment_id),
            'alt_text' => (string) get_post_meta($attachment_id, '_wp_attachment_image_alt', true),
            'mime_type' => get_post_mime_type($attachment_id),
            'width' => is_array($metadata) && isset($metadata['width']) ? absint($metadata['width']) : null,
            'height' => is_array($metadata) && isset($metadata['height']) ? absint($metadata['height']) : null,
        );
    }

    private static function current_attachment_id($slot) {
        $value = self::read_slot($slot);
        if (is_wp_error($value)) {
            return $value;
        }
        return $value['attachment_id'];
    }

    private static function call_write($slot, $value) {
        try {
            $result = call_user_func($slot['write_callback'], $value);
        } catch (Throwable $error) {
            return self::error('bridge_error', 'The site could not update this managed location.', 500);
        }
        if ($result === false || is_wp_error($result)) {
            return self::error('bridge_error', 'The site could not update this managed location.', 500);
        }
        return true;
    }

    private static function valid_id($id) {
        return is_string($id) && preg_match('/^[a-z][a-z0-9_-]{0,99}$/', $id) === 1;
    }

    private static function capability($args, $key, $fallback) {
        if (!isset($args[$key]) || !is_string($args[$key])) {
            return $fallback;
        }
        $value = sanitize_key($args[$key]);
        return $value === '' ? $fallback : $value;
    }

    private static function error($code, $message, $status) {
        return new WP_Error($code, $message, array('status' => $status));
    }
}

function use_brian_register_managed_page($id, $args) {
    return Use_Brian_Managed_Content::register_page($id, $args);
}

function use_brian_register_managed_slot($page_id, $slot_id, $args) {
    return Use_Brian_Managed_Content::register_slot($page_id, $slot_id, $args);
}

add_action('rest_api_init', array('Use_Brian_Managed_Content', 'register_routes'));
