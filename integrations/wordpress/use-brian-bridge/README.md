# Use Brian Bridge for WordPress

This OSS plugin exposes only the text and image locations that site code explicitly registers. It is the required server-side half of Brian's minimal WordPress connector.

## Install

1. Copy `use-brian-bridge/` into `wp-content/plugins/` and activate **Use Brian Bridge**.
2. Register managed pages and slots in a small site plugin or the active theme.
3. Add matching `data-brian-slot` attributes to rendered markup when you want screenshot-grounded editing.
4. Create a WordPress Application Password for an editor account and connect the site in Brian.

## Example

This example stores fictional homepage values in WordPress options. A real custom theme should point the callbacks at the theme's canonical storage instead.

```php
add_action('use_brian_register_managed_content', function () {
    use_brian_register_managed_page('home', array(
        'label' => 'Home',
        'url' => home_url('/'),
    ));

    use_brian_register_managed_slot('home', 'intro_text', array(
        'type' => 'text',
        'label' => 'Introduction',
        'section' => 'Intro',
        'aliases' => array('opening paragraph', 'text beside the portrait'),
        'selector' => '[data-brian-slot="intro_text"]',
        'read_callback' => function () {
            return (string) get_option('example_intro_text', 'Welcome to Example Studio.');
        },
        'write_callback' => function ($value) {
            update_option('example_intro_text', $value);
            return true;
        },
    ));

    use_brian_register_managed_slot('home', 'profile_image', array(
        'type' => 'image',
        'label' => 'Profile image',
        'section' => 'Intro',
        'aliases' => array('portrait', 'photo beside the introduction'),
        'selector' => '[data-brian-slot="profile_image"]',
        'read_callback' => function () {
            $id = get_option('example_profile_image_id');
            return $id ? (int) $id : null;
        },
        'write_callback' => function ($attachment_id) {
            update_option('example_profile_image_id', (int) $attachment_id);
            return true;
        },
    ));
});
```

Render the stable marker without making it a write input:

```php
<img data-brian-slot="profile_image" src="<?php echo esc_url(wp_get_attachment_url((int) get_option('example_profile_image_id'))); ?>" alt="">
```

The bridge creates a new Media Library attachment on replacement and leaves the previous attachment intact for rollback. It never accepts arbitrary option names, post-meta keys, PHP, SQL, REST paths, or selectors from Brian.
