//! Delegate protocol requests and observe the clipboard source's lifetime.

use std::any::Any;

use smithay::{
    reexports::wayland_server::{
        Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
        backend::ClientId, protocol::wl_data_device,
    },
    wayland::{Dispatch2, GlobalDispatch2},
};

use crate::State;

impl<I: Resource, U: Dispatch2<I, Self>> Dispatch<I, U> for State
where
    I::Request: 'static,
{
    fn request(state: &mut Self, client: &Client, resource: &I, request: I::Request, data: &U, dh: &DisplayHandle, init: &mut DataInit<'_, Self>) {
        let owner = match (&request as &dyn Any).downcast_ref::<wl_data_device::Request>() {
            Some(wl_data_device::Request::SetSelection { source, .. }) => source.clone(),
            _ => None,
        };
        let generation = state.reading.generation;
        data.request(state, client, resource, request, dh, init);
        // Only an accepted selection invokes new_selection and invalidates the read.
        if owner.is_some() && generation != state.reading.generation {
            state.reading.owner = owner;
        }
    }

    fn destroyed(state: &mut Self, client: ClientId, resource: &I, data: &U) {
        let clipboard_owner = state.reading.owner.as_ref().is_some_and(|owner| owner.id() == resource.id());
        data.destroyed(state, client, resource);
        // Smithay clears the seat selection here without calling new_selection.
        if clipboard_owner {
            state.clipboard_offer(None, false);
            if let Some(xwm) = state.xwm.as_mut()
                && let Err(error) = xwm.new_selection(smithay::wayland::selection::SelectionTarget::Clipboard, None)
            {
                tracing::warn!("xwayland selection: {error:?}");
            }
        }
    }
}

impl<I: Resource, U: GlobalDispatch2<I, Self>> GlobalDispatch<I, U> for State {
    fn bind(state: &mut Self, dh: &DisplayHandle, client: &Client, resource: New<I>, data: &U, init: &mut DataInit<'_, Self>) {
        data.bind(state, dh, client, resource, init);
    }

    fn can_view(client: Client, data: &U) -> bool {
        data.can_view(&client)
    }
}
